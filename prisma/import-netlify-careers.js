/**
 * One-off import of the careers data the old Astro site (planettalk-web-app) kept in
 * Netlify Blobs: job postings, applications, and CV files.
 *
 * PLAIN JS so it runs inside the production container, like seed-admin.js:
 *   docker compose exec app node prisma/import-netlify-careers.js /tmp/netlify-careers-export
 *
 * The export directory is what `netlify blobs:get` produced:
 *   jobs/<jobId>.json           (store careers-jobs, key job:<jobId>)
 *   applications/<appId>.json   (store careers-applications, key app:<jobId>:<appId>)
 *   cvs/<appId>.bin             (store careers-cvs, key cv:<appId>)
 *
 * Safe to re-run: applications keep their Netlify uuid as the primary key and postings
 * are matched by slug, so anything already imported is skipped. Each CV is uploaded
 * before its row is written, so a failed upload never leaves a row pointing at nothing.
 *
 * Flags:
 *   --dry-run          report what would happen, write nothing
 *   --skip-cv-upload   write rows without uploading CVs (local testing without Spaces keys)
 *
 * No emails are sent — these candidates were already acknowledged by the old site.
 */
const fs = require('fs')
const path = require('path')
const { PrismaClient } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3')

const JOB_STATUS = { open: 'OPEN', closed: 'CLOSED' }
const APPLICATION_STATUS = { new: 'NEW', shortlisted: 'SHORTLISTED', rejected: 'REJECTED', hired: 'HIRED' }

function readJsonDir(dir) {
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')))
}

/** The new schema has no summary column, so it leads the description instead of being lost. */
function jobDescription(job) {
  const summary = (job.summary || '').trim()
  const description = (job.description || '').trim()
  return summary && !description.startsWith(summary) ? `${summary}\n\n${description}` : description
}

async function main() {
  const args = process.argv.slice(2)
  const dir = args.find((a) => !a.startsWith('--'))
  const dryRun = args.includes('--dry-run')
  const skipCvUpload = args.includes('--skip-cv-upload')
  if (!dir) throw new Error('Usage: node prisma/import-netlify-careers.js <export-dir> [--dry-run] [--skip-cv-upload]')

  const jobs = readJsonDir(path.join(dir, 'jobs'))
  const applications = readJsonDir(path.join(dir, 'applications'))
  console.log(`Export: ${jobs.length} job(s), ${applications.length} application(s)${dryRun ? ' [dry run]' : ''}`)

  const bucket = process.env.DO_SPACES_BUCKET
  if (!skipCvUpload && !dryRun && (!bucket || !process.env.DO_SPACES_KEY || !process.env.DO_SPACES_SECRET)) {
    throw new Error('DO_SPACES_BUCKET/KEY/SECRET are required to upload CVs (or pass --skip-cv-upload)')
  }
  const s3 = new S3Client({
    region: process.env.DO_SPACES_REGION || 'us-east-1',
    endpoint: process.env.DO_SPACES_ENDPOINT,
    credentials: { accessKeyId: process.env.DO_SPACES_KEY || '', secretAccessKey: process.env.DO_SPACES_SECRET || '' },
  })

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

  // Netlify job id → new JobPosting id.
  const postingIds = new Map()
  for (const job of jobs) {
    let posting = await prisma.jobPosting.findUnique({ where: { slug: job.id } })
    if (!posting) {
      // A role re-posted by hand in the new admin gets the applications rather than a
      // duplicate listing on the public board.
      posting = await prisma.jobPosting.findFirst({ where: { title: job.title }, orderBy: { createdAt: 'asc' } })
      if (posting) console.log(`Job ${job.id}: attaching to existing posting "${posting.slug}" with the same title`)
    }
    if (!posting && !dryRun) {
      posting = await prisma.jobPosting.create({
        data: {
          slug: job.id,
          title: job.title,
          department: job.department || '',
          location: job.location || '',
          employmentType: job.employmentType || 'full-time',
          description: jobDescription(job),
          status: JOB_STATUS[job.status] || 'CLOSED',
          createdAt: job.postedAt ? new Date(job.postedAt) : undefined,
        },
      })
      console.log(`Job ${job.id}: created`)
    } else if (!posting) {
      console.log(`Job ${job.id}: would create`)
    } else if (posting.slug === job.id) {
      console.log(`Job ${job.id}: already imported`)
    }
    postingIds.set(job.id, posting ? posting.id : null)
  }

  let created = 0
  let skipped = 0
  for (const app of applications) {
    const label = app.id.slice(0, 8)
    if (await prisma.jobApplication.findUnique({ where: { id: app.id }, select: { id: true } })) {
      console.log(`Application ${label}: already imported`)
      skipped++
      continue
    }

    const cvPath = path.join(dir, 'cvs', `${app.id}.bin`)
    const cvBytes = fs.readFileSync(cvPath)
    if (app.cv && app.cv.size !== cvBytes.length) {
      throw new Error(`Application ${label}: CV is ${cvBytes.length} bytes, record says ${app.cv.size}`)
    }
    const extension = (app.cv && app.cv.extension) || 'pdf'
    const contentType = (app.cv && app.cv.contentType) || 'application/pdf'
    const cvKey = `cvs/${app.id}.${extension}`

    if (dryRun) {
      console.log(`Application ${label}: would import (${app.status}, ${extension} ${cvBytes.length} bytes)`)
      continue
    }

    if (!skipCvUpload) {
      await s3.send(new PutObjectCommand({ Bucket: bucket, Key: cvKey, Body: cvBytes, ContentType: contentType, ACL: 'private' }))
    }
    await prisma.jobApplication.create({
      data: {
        id: app.id,
        jobPostingId: postingIds.get(app.jobId) || null,
        jobTitleSnapshot: app.jobTitle || '',
        firstName: app.firstName,
        lastName: app.lastName,
        email: app.email,
        phone: app.phone || null,
        country: app.country || null,
        city: app.city || null,
        linkedin: app.linkedin || null,
        portfolio: app.portfolio || null,
        currentTitle: app.currentTitle || null,
        yearsExperience: app.yearsExperience,
        preferredLocation: app.preferredLocation,
        workPreference: app.workPreference,
        rightToWork: app.rightToWork,
        whyJoin: app.whyJoin,
        cvKey,
        cvOriginalFilename: (app.cv && app.cv.originalName) || `cv.${extension}`,
        cvContentType: contentType,
        cvSizeBytes: cvBytes.length,
        status: APPLICATION_STATUS[app.status] || 'NEW',
        rejectionSentAt: app.rejectionSentAt ? new Date(app.rejectionSentAt) : null,
        submittedAt: new Date(app.submittedAt),
      },
    })
    console.log(`Application ${label}: imported${skipCvUpload ? ' (CV upload skipped)' : ''}`)
    created++
  }

  console.log(`Done: ${created} imported, ${skipped} already present`)
  await prisma.$disconnect()
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
