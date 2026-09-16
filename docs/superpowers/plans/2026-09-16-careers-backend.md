# Careers Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build job postings, applications (with CV upload), and an admin-managed careers
module into TopupApi — replacing the Astro site's Netlify Blobs/Functions implementation, with
real per-admin auth and durable Postgres + object storage instead.

**Architecture:** A new `src/careers/` module following this repo's established `admin/*`
controller+service+DTO pattern exactly. Job postings and application metadata live in Postgres
(via Prisma); CV binaries live in DigitalOcean Spaces (S3-compatible). Admin endpoints reuse the
existing `JwtAuthGuard`/`AdminUser` system — no new auth surface. Emails go through a new,
isolated `CareersEmailService` built on the `mailgun.js` client already wired into this repo.

**Tech Stack:** NestJS 10, Prisma 7 + PostgreSQL, `@aws-sdk/client-s3` (new dependency, DO
Spaces), `@nestjs/platform-express` (`FileInterceptor`, already a dependency) for multipart CV
upload, `mailgun.js` (already a dependency), `@nestjs/schedule` (already wired) for the
retention cron, Jest with this repo's hand-mocked-Prisma testing convention.

**Spec:** `docs/superpowers/specs/2026-09-16-careers-backend-design.md`

## Global Constraints

- Closed-vocabulary values, exact strings, everywhere they're validated or displayed:
  - `yearsExperience`: `Less than 1 year`, `1–2 years`, `3–5 years`, `6–9 years`, `10+ years`
  - `workPreference`: `Remote`, `Hybrid`, `On-site`
  - `rightToWork`: `Yes`, `No`, `Need sponsorship`
- Application statuses: `NEW`, `SHORTLISTED`, `REJECTED`, `HIRED`. Job statuses: `OPEN`, `CLOSED`.
- CV files: only `application/pdf`, `application/msword`,
  `application/vnd.openxmlformats-officedocument.wordprocessingml.document` accepted; 5MB max;
  the stored filename is always server-generated, never the uploaded filename.
- Deleting a job posting must NOT delete its applications.
- A rejection email is sent by an explicit admin action, never as a side effect of a status
  change, and never sent twice (`rejectionSentAt` guards this).
- Every admin mutation is audited via the existing `AdminAuditLog` table, same pattern as
  `admin-users.service.ts`.
- Do not touch `src/payments/`, `src/providers/`, or any existing admin controller — this plan
  only adds new files plus two additive changes: a new Prisma migration, and one new relation
  field on the existing `AdminUser` model.
- Follow this repo's existing test convention exactly: hand-mocked Prisma object literals,
  services instantiated directly with `new Service(mockDep as any, ...)`, spec files
  co-located as `*.service.spec.ts` next to the file under test (not a separate `__tests__` dir).

---

### Task 1: Prisma schema — `JobPosting` and `JobApplication`

**Files:**
- Modify: `prisma/schema.prisma` (add two enums, two models, one relation field on `AdminUser`)
- Create: migration via `npx prisma migrate dev` (generates
  `prisma/migrations/<timestamp>_careers_job_postings_and_applications/migration.sql`)

**Interfaces:**
- Produces: Prisma Client types `JobPosting`, `JobApplication`, `JobStatus`,
  `ApplicationStatus` — every later task imports these from `@prisma/client`.

- [ ] **Step 1: Add the schema**

Append to `prisma/schema.prisma` (after the `AdminAuditLog` model, before the FX-cache section
comment):

```prisma
// ============================================
// Careers (job postings, applications, CV storage metadata)
// ============================================
// CV binary bytes live in DigitalOcean Spaces (see CareersStorageService), not here —
// this table only stores the storage key and file metadata. Deleting a JobPosting does
// NOT delete its applications (deliberate, matches the Astro implementation this
// replaces) — jobPostingId goes null and jobTitleSnapshot preserves what it was for.

enum JobStatus {
  OPEN
  CLOSED
}

enum ApplicationStatus {
  NEW
  SHORTLISTED
  REJECTED
  HIRED
}

model JobPosting {
  id               String    @id @default(uuid())
  slug             String    @unique
  title            String
  department       String
  location         String
  employmentType   String
  description      String    @db.Text
  status           JobStatus @default(OPEN)
  createdByAdminId String?
  createdByAdmin   AdminUser? @relation(fields: [createdByAdminId], references: [id], onDelete: SetNull)
  createdAt        DateTime  @default(now())
  updatedAt        DateTime  @updatedAt

  applications     JobApplication[]

  @@index([status])
  @@map("job_postings")
}

model JobApplication {
  id                 String            @id @default(uuid())
  jobPostingId       String?
  jobPosting         JobPosting?       @relation(fields: [jobPostingId], references: [id], onDelete: SetNull)
  // Captured at submission time so the application stays meaningful even after
  // the posting is deleted (Prisma's onDelete: SetNull leaves jobPostingId null).
  jobTitleSnapshot   String
  firstName          String
  lastName            String
  email              String
  phone              String?
  linkedin           String?
  portfolio          String?
  currentTitle       String?
  yearsExperience    String
  preferredLocation  String
  workPreference     String
  rightToWork        String
  whyJoin            String            @db.Text
  cvKey              String
  cvOriginalFilename String
  cvContentType      String
  cvSizeBytes        Int
  status             ApplicationStatus @default(NEW)
  rejectionSentAt    DateTime?
  submittedAt        DateTime          @default(now())
  updatedAt          DateTime          @updatedAt

  @@index([jobPostingId])
  @@index([status])
  @@index([submittedAt])
  @@map("job_applications")
}
```

Fix the typo in the pasted block above (`lastName            String` has misaligned spacing from
this document, not a schema error) — just ensure valid Prisma syntax; alignment is cosmetic.

Add the reverse relation to the existing `AdminUser` model (find it in the current
`prisma/schema.prisma` and add one line inside its field list, alongside the existing
`auditLogs AdminAuditLog[]` line):

```prisma
  jobPostings  JobPosting[]
```

- [ ] **Step 2: Generate and apply the migration locally**

Run: `npx prisma migrate dev --name careers_job_postings_and_applications`
Expected: creates `prisma/migrations/<timestamp>_careers_job_postings_and_applications/migration.sql`
containing `CREATE TYPE "JobStatus"`, `CREATE TYPE "ApplicationStatus"`, `CREATE TABLE
"job_postings"`, `CREATE TABLE "job_applications"`, and the FK constraints; regenerates the
Prisma client.

- [ ] **Step 3: Verify the client compiles**

Run: `npx tsc --noEmit`
Expected: no type errors — confirms `@prisma/client` now exports `JobPosting`, `JobApplication`,
`JobStatus`, `ApplicationStatus`, and `AdminUser` now has a `.jobPostings` relation.

- [ ] **Step 4: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/
git commit -m "feat(db): add JobPosting and JobApplication models"
```

---

### Task 2: CV storage — DigitalOcean Spaces

**Files:**
- Create: `src/careers/careers-storage.service.ts`
- Create: `src/careers/careers-storage.service.spec.ts`
- Modify: `package.json` (add `@aws-sdk/client-s3`)
- Modify: `.env.example` (document new env vars)

**Interfaces:**
- Produces: `CareersStorageService` with `uploadCv(params: { key: string; body: Buffer;
  contentType: string }): Promise<void>`, `getCvStream(key: string): Promise<{ body:
  ReadableStream | Readable; contentType: string; contentLength?: number }>`,
  `deleteCv(key: string): Promise<void>`, `generateCvKey(applicationId: string, extension:
  string): string` — Task 5 (apply endpoint) and Task 7 (admin CV download/delete) consume all
  four.

- [ ] **Step 1: Add the dependency**

```bash
npm install @aws-sdk/client-s3
```

- [ ] **Step 2: Write the failing test**

Create `src/careers/careers-storage.service.spec.ts`:

```ts
import { CareersStorageService } from './careers-storage.service'

const send = jest.fn()
jest.mock('@aws-sdk/client-s3', () => {
  const actual = jest.requireActual('@aws-sdk/client-s3')
  return {
    ...actual,
    S3Client: jest.fn().mockImplementation(() => ({ send })),
  }
})

function buildConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    DO_SPACES_KEY: 'key123',
    DO_SPACES_SECRET: 'secret123',
    DO_SPACES_BUCKET: 'planettalk-careers',
    DO_SPACES_REGION: 'fra1',
    DO_SPACES_ENDPOINT: 'https://fra1.digitaloceanspaces.com',
    ...overrides,
  }
  return { get: (k: string) => values[k] }
}

describe('CareersStorageService', () => {
  beforeEach(() => send.mockReset())

  it('generates a key from the application id and extension, never the original filename', () => {
    const service = new CareersStorageService(buildConfig() as any)
    const key = service.generateCvKey('app-123', 'pdf')
    expect(key).toBe('cvs/app-123.pdf')
  })

  it('uploads a CV via PutObjectCommand', async () => {
    send.mockResolvedValue({})
    const service = new CareersStorageService(buildConfig() as any)
    await service.uploadCv({ key: 'cvs/app-123.pdf', body: Buffer.from('pdf-bytes'), contentType: 'application/pdf' })
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command.input).toMatchObject({
      Bucket: 'planettalk-careers',
      Key: 'cvs/app-123.pdf',
      ContentType: 'application/pdf',
    })
  })

  it('deletes a CV via DeleteObjectCommand', async () => {
    send.mockResolvedValue({})
    const service = new CareersStorageService(buildConfig() as any)
    await service.deleteCv('cvs/app-123.pdf')
    expect(send).toHaveBeenCalledTimes(1)
    const command = send.mock.calls[0][0]
    expect(command.input).toMatchObject({ Bucket: 'planettalk-careers', Key: 'cvs/app-123.pdf' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx jest careers-storage.service.spec.ts`
Expected: FAIL — `Cannot find module './careers-storage.service'`

- [ ] **Step 4: Implement the service**

Create `src/careers/careers-storage.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3'

export interface UploadCvParams {
  key: string
  body: Buffer
  contentType: string
}

export interface CvStream {
  body: NodeJS.ReadableStream
  contentType: string
  contentLength?: number
}

/**
 * CV binary storage on DigitalOcean Spaces (S3-compatible). Job posting/application
 * metadata lives in Postgres (Prisma) — this service only ever touches file bytes,
 * addressed by a server-generated key, never the uploader's original filename.
 */
@Injectable()
export class CareersStorageService {
  private readonly logger = new Logger(CareersStorageService.name)
  private readonly client: S3Client
  private readonly bucket: string

  constructor(private readonly config: ConfigService) {
    this.bucket = this.config.get<string>('DO_SPACES_BUCKET') ?? ''
    this.client = new S3Client({
      region: this.config.get<string>('DO_SPACES_REGION') ?? 'us-east-1',
      endpoint: this.config.get<string>('DO_SPACES_ENDPOINT'),
      credentials: {
        accessKeyId: this.config.get<string>('DO_SPACES_KEY') ?? '',
        secretAccessKey: this.config.get<string>('DO_SPACES_SECRET') ?? '',
      },
    })
  }

  generateCvKey(applicationId: string, extension: string): string {
    return `cvs/${applicationId}.${extension}`
  }

  async uploadCv(params: UploadCvParams): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: params.key,
        Body: params.body,
        ContentType: params.contentType,
        ACL: 'private',
      }),
    )
  }

  async getCvStream(key: string): Promise<CvStream> {
    const result = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }))
    return {
      body: result.Body as unknown as NodeJS.ReadableStream,
      contentType: result.ContentType ?? 'application/octet-stream',
      contentLength: result.ContentLength,
    }
  }

  async deleteCv(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }))
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx jest careers-storage.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 6: Document the new env vars**

Add to `.env.example` (near the other integration-credential sections):

```
# DigitalOcean Spaces (S3-compatible) — careers CV storage
DO_SPACES_KEY=
DO_SPACES_SECRET=
DO_SPACES_BUCKET=planettalk-careers
DO_SPACES_REGION=fra1
DO_SPACES_ENDPOINT=https://fra1.digitaloceanspaces.com
```

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/careers/careers-storage.service.ts src/careers/careers-storage.service.spec.ts .env.example
git commit -m "feat(careers): add DigitalOcean Spaces CV storage service"
```

---

### Task 3: Careers email service

**Files:**
- Create: `src/careers/careers-email.service.ts`
- Create: `src/careers/careers-email.service.spec.ts`

**Interfaces:**
- Consumes: `ConfigService` (standard Nest DI).
- Produces: `CareersEmailService` with `sendApplicationReceived(params: { to: string; jobTitle:
  string; applicantFirstName: string }): Promise<void>`,
  `sendNewApplicationAlert(params: { jobTitle: string; applicantName: string; applicationId:
  string }): Promise<void>`, `sendRejection(params: { to: string; applicantFirstName: string;
  jobTitle: string }): Promise<boolean>` (returns whether it actually sent, so the caller can
  gate `rejectionSentAt`) — Task 5 and Task 7 consume these.

Isolated from `CustomerEmailService`/`AlertService` deliberately (own file, own `FROM` address
env var) — same precedent the Astro implementation set for careers ("deliberately isolated...
separate email module, separate FROM env var... a precedent worth following").

- [ ] **Step 1: Write the failing test**

Create `src/careers/careers-email.service.spec.ts`:

```ts
import { CareersEmailService } from './careers-email.service'

const create = jest.fn()
jest.mock('mailgun.js', () => {
  return jest.fn().mockImplementation(() => ({
    client: () => ({ messages: { create } }),
  }))
})

function buildConfig(overrides: Record<string, string> = {}) {
  const values: Record<string, string> = {
    MAILGUN_API_KEY: 'key',
    MAILGUN_DOMAIN: 'www.planettalk.com',
    MAILGUN_API_URL: 'https://api.eu.mailgun.net',
    CAREERS_FROM_EMAIL: 'PlanetTalk Careers <jointheclan@planettalk.com>',
    CAREERS_NOTIFY_EMAIL: 'jointheclan@planettalk.com',
    ...overrides,
  }
  return { get: (k: string) => values[k] }
}

describe('CareersEmailService', () => {
  beforeEach(() => create.mockReset())

  it('sends an application-received email to the applicant', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    await service.sendApplicationReceived({
      to: 'candidate@example.com',
      jobTitle: 'Backend Engineer',
      applicantFirstName: 'Jamie',
    })
    expect(create).toHaveBeenCalledTimes(1)
    const [domain, message] = create.mock.calls[0]
    expect(domain).toBe('www.planettalk.com')
    expect(message.to).toEqual(['candidate@example.com'])
    expect(message.from).toBe('PlanetTalk Careers <jointheclan@planettalk.com>')
  })

  it('sends a new-application alert to the notify address', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    await service.sendNewApplicationAlert({
      jobTitle: 'Backend Engineer',
      applicantName: 'Jamie Doe',
      applicationId: 'app-1',
    })
    const [, message] = create.mock.calls[0]
    expect(message.to).toEqual(['jointheclan@planettalk.com'])
    expect(message['h:Reply-To']).toBeUndefined()
  })

  it('sendRejection returns true and sends once', async () => {
    create.mockResolvedValue({})
    const service = new CareersEmailService(buildConfig() as any)
    const sent = await service.sendRejection({
      to: 'candidate@example.com',
      applicantFirstName: 'Jamie',
      jobTitle: 'Backend Engineer',
    })
    expect(sent).toBe(true)
    expect(create).toHaveBeenCalledTimes(1)
  })

  it('never throws when Mailgun is not configured — logs and returns false/no-op', async () => {
    const service = new CareersEmailService(buildConfig({ MAILGUN_API_KEY: '' }) as any)
    const sent = await service.sendRejection({
      to: 'candidate@example.com',
      applicantFirstName: 'Jamie',
      jobTitle: 'Backend Engineer',
    })
    expect(sent).toBe(false)
    await expect(
      service.sendApplicationReceived({ to: 'x@example.com', jobTitle: 'X', applicantFirstName: 'X' }),
    ).resolves.toBeUndefined()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest careers-email.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service**

Create `src/careers/careers-email.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Mailgun from 'mailgun.js'
import * as FormData from 'form-data'

export interface ApplicationReceivedParams {
  to: string
  jobTitle: string
  applicantFirstName: string
}

export interface NewApplicationAlertParams {
  jobTitle: string
  applicantName: string
  applicationId: string
}

export interface RejectionParams {
  to: string
  applicantFirstName: string
  jobTitle: string
}

/**
 * Careers-specific Mailgun wiring, deliberately isolated from CustomerEmailService/
 * AlertService (own FROM address, own file) — same isolation the Astro careers feature
 * used, carried forward here. Fire-and-forget for applicant-facing sends; sendRejection
 * is the one exception (returns whether it actually sent, so the caller can gate
 * rejectionSentAt and never claim a rejection was sent when it wasn't).
 */
@Injectable()
export class CareersEmailService {
  private readonly logger = new Logger(CareersEmailService.name)
  private mailgunClient: ReturnType<InstanceType<typeof Mailgun>['client']> | null = null
  private readonly domain: string
  private readonly fromEmail: string
  private readonly notifyEmail: string

  constructor(private readonly config: ConfigService) {
    this.domain = this.config.get<string>('MAILGUN_DOMAIN') ?? ''
    this.fromEmail =
      this.config.get<string>('CAREERS_FROM_EMAIL') ?? 'PlanetTalk Careers <jointheclan@planettalk.com>'
    this.notifyEmail = this.config.get<string>('CAREERS_NOTIFY_EMAIL') ?? 'jointheclan@planettalk.com'

    const apiKey = this.config.get<string>('MAILGUN_API_KEY')
    const apiUrl = this.config.get<string>('MAILGUN_API_URL') ?? 'https://api.mailgun.net'

    if (apiKey && this.domain) {
      const mailgun = new Mailgun(FormData as unknown as typeof FormData)
      this.mailgunClient = mailgun.client({ username: 'api', key: apiKey, url: apiUrl })
    } else {
      this.logger.warn('Mailgun not configured — careers emails disabled')
    }
  }

  async sendApplicationReceived(params: ApplicationReceivedParams): Promise<void> {
    if (!this.mailgunClient) return
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [params.to],
        subject: `We received your application — ${params.jobTitle}`,
        text: `Hi ${params.applicantFirstName},\n\nThanks for applying to PlanetTalk for the ${params.jobTitle} role. We've received your application and will be in touch.\n\n— The PlanetTalk team`,
      })
    } catch (err) {
      this.logger.error('Failed to send application-received email', err as Error)
    }
  }

  async sendNewApplicationAlert(params: NewApplicationAlertParams): Promise<void> {
    if (!this.mailgunClient) return
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [this.notifyEmail],
        subject: `New application: ${params.jobTitle}`,
        text: `${params.applicantName} applied for ${params.jobTitle}.\n\nReview it in the admin console (application ${params.applicationId}).`,
      })
    } catch (err) {
      this.logger.error('Failed to send new-application alert', err as Error)
    }
  }

  async sendRejection(params: RejectionParams): Promise<boolean> {
    if (!this.mailgunClient) return false
    try {
      await this.mailgunClient.messages.create(this.domain, {
        from: this.fromEmail,
        to: [params.to],
        subject: `Update on your application — ${params.jobTitle}`,
        text: `Hi ${params.applicantFirstName},\n\nThank you for your interest in the ${params.jobTitle} role at PlanetTalk. After careful consideration, we've decided not to move forward with your application at this time.\n\nWe appreciate the time you took to apply and wish you the best in your search.\n\n— The PlanetTalk team`,
      })
      return true
    } catch (err) {
      this.logger.error('Failed to send rejection email', err as Error)
      return false
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest careers-email.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/careers/careers-email.service.ts src/careers/careers-email.service.spec.ts
git commit -m "feat(careers): add isolated CareersEmailService (Mailgun)"
```

---

### Task 4: Public read endpoints — list and detail

**Files:**
- Create: `src/careers/careers.controller.ts`
- Create: `src/careers/careers.service.ts`
- Create: `src/careers/careers.service.spec.ts`
- Create: `src/careers/careers.module.ts`
- Modify: `src/app.module.ts` (register `CareersModule`)

**Interfaces:**
- Produces: `GET /api/careers/jobs` (public, open postings only, whitelisted fields),
  `GET /api/careers/jobs/:id` (public, any status — the frontend plan needs to render a
  "closed" state, matching Astro's 200-not-404 behavior for closed-but-real roles).
  `CareersService.listOpenJobs()` and `CareersService.getJobById(id: string)` are consumed by
  Task 5 (the apply endpoint re-checks the job is open before accepting a submission).

- [ ] **Step 1: Write the failing test**

Create `src/careers/careers.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common'
import { CareersService } from './careers.service'

describe('CareersService', () => {
  let prisma: { jobPosting: { findMany: jest.Mock; findUnique: jest.Mock } }
  let service: CareersService

  beforeEach(() => {
    prisma = {
      jobPosting: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    }
    service = new CareersService(prisma as any)
  })

  describe('listOpenJobs', () => {
    it('queries only OPEN postings, newest first, whitelisted fields', async () => {
      await service.listOpenJobs()
      expect(prisma.jobPosting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
        }),
      )
      const call = prisma.jobPosting.findMany.mock.calls[0][0]
      expect(call.select).toMatchObject({
        id: true,
        slug: true,
        title: true,
        department: true,
        location: true,
        employmentType: true,
        createdAt: true,
      })
      expect(call.select.description).toBeUndefined()
    })
  })

  describe('getJobById', () => {
    it('throws NotFoundException when the id does not exist', async () => {
      prisma.jobPosting.findUnique.mockResolvedValue(null)
      await expect(service.getJobById('missing')).rejects.toBeInstanceOf(NotFoundException)
    })

    it('returns the job regardless of status (closed roles still resolve)', async () => {
      const closedJob = { id: 'job-1', status: 'CLOSED', title: 'X' }
      prisma.jobPosting.findUnique.mockResolvedValue(closedJob)
      const result = await service.getJobById('job-1')
      expect(result).toEqual(closedJob)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest careers.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the service, controller, and module**

Create `src/careers/careers.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { JobStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'

const PUBLIC_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  department: true,
  location: true,
  employmentType: true,
  createdAt: true,
} as const

@Injectable()
export class CareersService {
  constructor(private readonly prisma: PrismaService) {}

  listOpenJobs() {
    return this.prisma.jobPosting.findMany({
      where: { status: JobStatus.OPEN },
      select: PUBLIC_LIST_SELECT,
      orderBy: { createdAt: 'desc' },
    })
  }

  async getJobById(id: string) {
    const job = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!job) throw new NotFoundException('Job posting not found')
    return job
  }
}
```

Create `src/careers/careers.controller.ts`:

```ts
import { Controller, Get, Param } from '@nestjs/common'
import { CareersService } from './careers.service'

@Controller('careers')
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Get('jobs')
  listJobs() {
    return this.careers.listOpenJobs()
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.careers.getJobById(id)
  }
}
```

Create `src/careers/careers.module.ts`:

```ts
import { Module } from '@nestjs/common'
import { CareersController } from './careers.controller'
import { CareersService } from './careers.service'
import { CareersStorageService } from './careers-storage.service'
import { CareersEmailService } from './careers-email.service'

@Module({
  controllers: [CareersController],
  providers: [CareersService, CareersStorageService, CareersEmailService],
  exports: [CareersStorageService, CareersEmailService],
})
export class CareersModule {}
```

Modify `src/app.module.ts`: add `import { CareersModule } from './careers/careers.module'` and
add `CareersModule` to the `imports` array (alongside `CreditbackModule` etc).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest careers.service.spec.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Full build check and commit**

Run: `npx tsc --noEmit`

```bash
git add src/careers/careers.controller.ts src/careers/careers.service.ts src/careers/careers.service.spec.ts src/careers/careers.module.ts src/app.module.ts
git commit -m "feat(careers): public job listing and detail endpoints"
```

---

### Task 5: Public apply endpoint

**Files:**
- Modify: `src/careers/careers.controller.ts` (add `POST careers/jobs/:id/apply`)
- Modify: `src/careers/careers.service.ts` (add `submitApplication`)
- Modify: `src/careers/careers.service.spec.ts` (add coverage)
- Create: `src/careers/dto/submit-application.dto.ts`

**Interfaces:**
- Consumes: `CareersStorageService.uploadCv`/`generateCvKey` (Task 2),
  `CareersEmailService.sendApplicationReceived`/`sendNewApplicationAlert` (Task 3).
- Produces: `POST /api/careers/jobs/:id/apply` (public, multipart/form-data, 5/10min throttle
  matching the creditback-claim precedent).

- [ ] **Step 1: Write the failing test**

Add to `src/careers/careers.service.spec.ts`:

```ts
describe('submitApplication', () => {
  let storage: { generateCvKey: jest.Mock; uploadCv: jest.Mock }
  let email: { sendApplicationReceived: jest.Mock; sendNewApplicationAlert: jest.Mock }

  beforeEach(() => {
    storage = {
      generateCvKey: jest.fn().mockReturnValue('cvs/app-1.pdf'),
      uploadCv: jest.fn().mockResolvedValue(undefined),
    }
    email = {
      sendApplicationReceived: jest.fn().mockResolvedValue(undefined),
      sendNewApplicationAlert: jest.fn().mockResolvedValue(undefined),
    }
    ;(service as any).storage = storage
    ;(service as any).email = email
  })

  const validDto = {
    firstName: 'Jamie',
    lastName: 'Doe',
    email: 'jamie@example.com',
    yearsExperience: '3–5 years',
    preferredLocation: 'UK',
    workPreference: 'Remote',
    rightToWork: 'Yes',
    whyJoin: 'Because PlanetTalk matters to me.',
  }
  const cvFile = { buffer: Buffer.from('pdf'), mimetype: 'application/pdf', size: 1024 }

  it('rejects when the job does not exist', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue(null)
    await expect(service.submitApplication('missing', validDto as any, cvFile as any)).rejects.toThrow()
  })

  it('rejects when the job is closed', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', status: 'CLOSED', title: 'X' })
    await expect(service.submitApplication('job-1', validDto as any, cvFile as any)).rejects.toThrow()
  })

  it('creates the application, uploads the CV, and sends both emails on success', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', status: 'OPEN', title: 'Backend Engineer' })
    prisma.jobApplication = { create: jest.fn().mockResolvedValue({ id: 'app-1', ...validDto }) }
    const result = await service.submitApplication('job-1', validDto as any, cvFile as any)
    expect(storage.uploadCv).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'cvs/app-1.pdf', contentType: 'application/pdf' }),
    )
    expect(email.sendApplicationReceived).toHaveBeenCalled()
    expect(email.sendNewApplicationAlert).toHaveBeenCalled()
    expect(result).toEqual({ id: 'app-1' })
  })
})
```

Note this test needs `prisma.jobApplication` added to the `beforeEach` mock at the top of the
file — add `jobApplication: { create: jest.fn() }` to the outer `prisma` object literal.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest careers.service.spec.ts`
Expected: FAIL — `submitApplication` does not exist.

- [ ] **Step 3: Implement**

Create `src/careers/dto/submit-application.dto.ts`:

```ts
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, Matches } from 'class-validator'

export const YEARS_OF_EXPERIENCE = ['Less than 1 year', '1–2 years', '3–5 years', '6–9 years', '10+ years']
export const WORK_PREFERENCES = ['Remote', 'Hybrid', 'On-site']
export const RIGHT_TO_WORK = ['Yes', 'No', 'Need sponsorship']

const URL_RE = /^https?:\/\//i

export class SubmitApplicationDto {
  @IsString() @MaxLength(100) firstName!: string
  @IsString() @MaxLength(100) lastName!: string
  @IsEmail() @MaxLength(254) email!: string
  @IsOptional() @IsString() @MaxLength(30) phone?: string
  @IsOptional() @IsString() @Matches(URL_RE, { message: 'linkedin must be an http(s) URL' }) @MaxLength(500) linkedin?: string
  @IsOptional() @IsString() @Matches(URL_RE, { message: 'portfolio must be an http(s) URL' }) @MaxLength(500) portfolio?: string
  @IsOptional() @IsString() @MaxLength(200) currentTitle?: string
  @IsIn(YEARS_OF_EXPERIENCE) yearsExperience!: string
  @IsString() @MaxLength(200) preferredLocation!: string
  @IsIn(WORK_PREFERENCES) workPreference!: string
  @IsIn(RIGHT_TO_WORK) rightToWork!: string
  @IsString() @MaxLength(5000) whyJoin!: string
}
```

Modify `src/careers/careers.service.ts` — add imports (`BadRequestException`,
`CareersStorageService`, `CareersEmailService`, `SubmitApplicationDto`) and inject the two new
services in the constructor, then add:

```ts
  async submitApplication(
    jobId: string,
    dto: SubmitApplicationDto,
    cv: { buffer: Buffer; mimetype: string; size: number },
  ) {
    const job = await this.prisma.jobPosting.findUnique({ where: { id: jobId } })
    if (!job) throw new NotFoundException('Job posting not found')
    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('That role is no longer accepting applications')
    }

    const ALLOWED_CV_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    const CV_MAX_BYTES = 5 * 1024 * 1024
    if (!ALLOWED_CV_TYPES.includes(cv.mimetype)) {
      throw new BadRequestException('CV must be a PDF or Word document')
    }
    if (cv.size > CV_MAX_BYTES) {
      throw new BadRequestException('CV must be 5MB or smaller')
    }

    const application = await this.prisma.jobApplication.create({
      data: {
        jobPostingId: job.id,
        jobTitleSnapshot: job.title,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        linkedin: dto.linkedin,
        portfolio: dto.portfolio,
        currentTitle: dto.currentTitle,
        yearsExperience: dto.yearsExperience,
        preferredLocation: dto.preferredLocation,
        workPreference: dto.workPreference,
        rightToWork: dto.rightToWork,
        whyJoin: dto.whyJoin,
        cvKey: '', // set below after upload, updated in place
        cvOriginalFilename: '',
        cvContentType: cv.mimetype,
        cvSizeBytes: cv.size,
      },
    })

    const extension = cv.mimetype === 'application/pdf' ? 'pdf' : 'docx'
    const cvKey = this.storage.generateCvKey(application.id, extension)
    await this.storage.uploadCv({ key: cvKey, body: cv.buffer, contentType: cv.mimetype })
    await this.prisma.jobApplication.update({ where: { id: application.id }, data: { cvKey } })

    await this.email.sendApplicationReceived({
      to: dto.email,
      jobTitle: job.title,
      applicantFirstName: dto.firstName,
    })
    await this.email.sendNewApplicationAlert({
      jobTitle: job.title,
      applicantName: `${dto.firstName} ${dto.lastName}`,
      applicationId: application.id,
    })

    return { id: application.id }
  }
```

Note: the test's mock `prisma.jobApplication.create` returns an object without an `update`
call being separately mocked — add `update: jest.fn().mockResolvedValue({})` to the test's
`prisma.jobApplication` mock object alongside `create` so this passes.

Modify `src/careers/careers.controller.ts` — add the multipart route:

```ts
import { Body, Controller, Get, Param, Post, UploadedFile, UseInterceptors, BadRequestException } from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import { SubmitApplicationDto } from './dto/submit-application.dto'
// ...existing imports...

  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('jobs/:id/apply')
  @UseInterceptors(FileInterceptor('cv', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async apply(
    @Param('id') id: string,
    @Body() dto: SubmitApplicationDto,
    @UploadedFile() cv?: Express.Multer.File,
  ) {
    if (!cv) throw new BadRequestException('A CV file is required')
    return this.careers.submitApplication(id, dto, cv)
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest careers.service.spec.ts`
Expected: PASS (all cases in the file)

- [ ] **Step 5: Full build check and commit**

Run: `npx tsc --noEmit`

```bash
git add src/careers/careers.controller.ts src/careers/careers.service.ts src/careers/careers.service.spec.ts src/careers/dto/submit-application.dto.ts
git commit -m "feat(careers): public application submission with CV upload"
```

---

### Task 6: Admin — job postings CRUD

**Files:**
- Create: `src/admin/admin-job-postings.controller.ts`
- Create: `src/admin/admin-job-postings.service.ts`
- Create: `src/admin/admin-job-postings.service.spec.ts`
- Create: `src/admin/dto/job-posting.dto.ts`
- Modify: `src/admin/admin.module.ts` (register controller + service)

**Interfaces:**
- Produces: `GET/POST/PATCH/DELETE /api/admin/job-postings` — all guarded, all audited.

- [ ] **Step 1: Write the failing test**

Create `src/admin/admin-job-postings.service.spec.ts`:

```ts
import { NotFoundException } from '@nestjs/common'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

const admin: AuthenticatedAdmin = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 'ADMIN' as AuthenticatedAdmin['role'] }

describe('AdminJobPostingsService', () => {
  let prisma: {
    jobPosting: { findMany: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; findUnique: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let service: AdminJobPostingsService

  beforeEach(() => {
    prisma = {
      jobPosting: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    service = new AdminJobPostingsService(prisma as any)
  })

  it('lists all postings regardless of status, newest first', async () => {
    await service.list()
    expect(prisma.jobPosting.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } })
  })

  it('creates a posting, generates a slug, and audits it', async () => {
    prisma.jobPosting.create.mockResolvedValue({ id: 'job-1', title: 'Backend Engineer', slug: 'backend-engineer-ab12cd' })
    const dto = { title: 'Backend Engineer', department: 'Engineering', location: 'Remote', employmentType: 'Full-time', description: 'desc' }
    const result = await service.create(dto as any, admin)
    expect(prisma.jobPosting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Backend Engineer', createdByAdminId: 'admin-1' }) }),
    )
    expect(result.id).toBe('job-1')
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'job_posting_create', target: 'job-1', result: 'Backend Engineer' },
    })
  })

  it('throws NotFoundException when updating a posting that does not exist', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue(null)
    await expect(service.update('missing', { title: 'X' } as any, admin)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('deletes a posting without touching its applications, and audits it', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', title: 'Backend Engineer' })
    await service.remove('job-1', admin)
    expect(prisma.jobPosting.delete).toHaveBeenCalledWith({ where: { id: 'job-1' } })
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'job_posting_delete', target: 'job-1', result: 'Backend Engineer' },
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-job-postings.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/admin/dto/job-posting.dto.ts`:

```ts
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { JobStatus } from '@prisma/client'

export class CreateJobPostingDto {
  @IsString() @MaxLength(200) title!: string
  @IsString() @MaxLength(100) department!: string
  @IsString() @MaxLength(200) location!: string
  @IsString() @MaxLength(100) employmentType!: string
  @IsString() @MaxLength(20_000) description!: string
}

export class UpdateJobPostingDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string
  @IsOptional() @IsString() @MaxLength(100) department?: string
  @IsOptional() @IsString() @MaxLength(200) location?: string
  @IsOptional() @IsString() @MaxLength(100) employmentType?: string
  @IsOptional() @IsString() @MaxLength(20_000) description?: string
  @IsOptional() @IsIn([JobStatus.OPEN, JobStatus.CLOSED]) status?: JobStatus
}
```

Create `src/admin/admin-job-postings.service.ts`:

```ts
import { Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { CreateJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto'

function slugify(title: string): string {
  const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const suffix = randomBytes(3).toString('hex')
  return `${base}-${suffix}`
}

@Injectable()
export class AdminJobPostingsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.jobPosting.findMany({ orderBy: { createdAt: 'desc' } })
  }

  async create(dto: CreateJobPostingDto, actor: AuthenticatedAdmin) {
    const posting = await this.prisma.jobPosting.create({
      data: { ...dto, slug: slugify(dto.title), createdByAdminId: actor.id },
    })
    await this.audit(actor, 'job_posting_create', posting.id, posting.title)
    return posting
  }

  async update(id: string, dto: UpdateJobPostingDto, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Job posting not found')

    const posting = await this.prisma.jobPosting.update({ where: { id }, data: dto })
    await this.audit(actor, 'job_posting_update', id, JSON.stringify(dto))
    return posting
  }

  async remove(id: string, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Job posting not found')

    // Deliberately does NOT touch applications — jobPostingId goes null via
    // the schema's onDelete: SetNull, jobTitleSnapshot preserves what it was for.
    await this.prisma.jobPosting.delete({ where: { id } })
    await this.audit(actor, 'job_posting_delete', id, existing.title)
    return { ok: true }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
```

Create `src/admin/admin-job-postings.controller.ts`:

```ts
import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { CreateJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto'

@Controller('admin/job-postings')
@UseGuards(JwtAuthGuard)
export class AdminJobPostingsController {
  constructor(private readonly postings: AdminJobPostingsService) {}

  @Get()
  list() {
    return this.postings.list()
  }

  @Post()
  create(@Body() dto: CreateJobPostingDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.create(dto, admin)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateJobPostingDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.update(id, dto, admin)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.remove(id, admin)
  }
}
```

Modify `src/admin/admin.module.ts`: import and register `AdminJobPostingsController` +
`AdminJobPostingsService` alongside the existing admin controllers/services.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-job-postings.service.spec.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Full build check and commit**

Run: `npx tsc --noEmit`

```bash
git add src/admin/admin-job-postings.controller.ts src/admin/admin-job-postings.service.ts src/admin/admin-job-postings.service.spec.ts src/admin/dto/job-posting.dto.ts src/admin/admin.module.ts
git commit -m "feat(careers): admin job postings CRUD"
```

---

### Task 7: Admin — applications management

**Files:**
- Create: `src/admin/admin-job-applications.controller.ts`
- Create: `src/admin/admin-job-applications.service.ts`
- Create: `src/admin/admin-job-applications.service.spec.ts`
- Create: `src/admin/dto/job-application.dto.ts`
- Modify: `src/admin/admin.module.ts` (register controller + service, import `CareersModule`
  for `CareersStorageService`/`CareersEmailService`)

**Interfaces:**
- Consumes: `CareersStorageService.getCvStream`/`deleteCv` (Task 2),
  `CareersEmailService.sendRejection` (Task 3).
- Produces: `GET /api/admin/job-applications` (list, filterable by `jobPostingId`/`status`),
  `PATCH /api/admin/job-applications/:id/status`, `POST /api/admin/job-applications/:id/reject`
  (distinct action, not a side effect of status change — matches Astro's
  `send-rejection`/`rejectionSentAt` dedup guard), `GET
  /api/admin/job-applications/:id/cv` (streams the file, `Content-Disposition: attachment` —
  never inline, matching the Astro implementation's explicit security precedent), `DELETE
  /api/admin/job-applications/:id` (deletes the application row and its CV together).

- [ ] **Step 1: Write the failing test**

Create `src/admin/admin-job-applications.service.spec.ts`:

```ts
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { AdminJobApplicationsService } from './admin-job-applications.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

const admin: AuthenticatedAdmin = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 'ADMIN' as AuthenticatedAdmin['role'] }

describe('AdminJobApplicationsService', () => {
  let prisma: {
    jobApplication: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let storage: { getCvStream: jest.Mock; deleteCv: jest.Mock }
  let email: { sendRejection: jest.Mock }
  let service: AdminJobApplicationsService

  beforeEach(() => {
    prisma = {
      jobApplication: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    storage = { getCvStream: jest.fn(), deleteCv: jest.fn().mockResolvedValue(undefined) }
    email = { sendRejection: jest.fn() }
    service = new AdminJobApplicationsService(prisma as any, storage as any, email as any)
  })

  describe('setStatus', () => {
    it('updates status and audits it', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'NEW' })
      prisma.jobApplication.update.mockResolvedValue({ id: 'app-1', status: 'SHORTLISTED' })
      const result = await service.setStatus('app-1', 'SHORTLISTED' as any, admin)
      expect(result.status).toBe('SHORTLISTED')
      expect(prisma.adminAuditLog.create).toHaveBeenCalled()
    })
  })

  describe('reject', () => {
    it('requires status to already be REJECTED before sending', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'NEW', email: 'x@example.com' })
      await expect(service.reject('app-1', admin)).rejects.toBeInstanceOf(BadRequestException)
      expect(email.sendRejection).not.toHaveBeenCalled()
    })

    it('refuses to send twice — checks rejectionSentAt', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', rejectionSentAt: new Date(),
      })
      await expect(service.reject('app-1', admin)).rejects.toBeInstanceOf(BadRequestException)
      expect(email.sendRejection).not.toHaveBeenCalled()
    })

    it('sends the rejection and stamps rejectionSentAt only on confirmed success', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', firstName: 'Jamie',
        jobTitleSnapshot: 'Backend Engineer', rejectionSentAt: null,
      })
      email.sendRejection.mockResolvedValue(true)
      await service.reject('app-1', admin)
      expect(prisma.jobApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'app-1' }, data: expect.objectContaining({ rejectionSentAt: expect.any(Date) }) }),
      )
    })

    it('does NOT stamp rejectionSentAt when the send fails', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', firstName: 'Jamie',
        jobTitleSnapshot: 'Backend Engineer', rejectionSentAt: null,
      })
      email.sendRejection.mockResolvedValue(false)
      await expect(service.reject('app-1', admin)).rejects.toThrow()
      expect(prisma.jobApplication.update).not.toHaveBeenCalled()
    })
  })

  describe('remove', () => {
    it('deletes the application and its CV together', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', cvKey: 'cvs/app-1.pdf', email: 'x@example.com' })
      await service.remove('app-1', admin)
      expect(storage.deleteCv).toHaveBeenCalledWith('cvs/app-1.pdf')
      expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } })
    })
  })

  describe('getCv', () => {
    it('throws NotFoundException when the application does not exist', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue(null)
      await expect(service.getCv('missing')).rejects.toBeInstanceOf(NotFoundException)
    })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest admin-job-applications.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/admin/dto/job-application.dto.ts`:

```ts
import { IsIn } from 'class-validator'
import { ApplicationStatus } from '@prisma/client'

export class SetApplicationStatusDto {
  @IsIn([ApplicationStatus.NEW, ApplicationStatus.SHORTLISTED, ApplicationStatus.REJECTED, ApplicationStatus.HIRED])
  status!: ApplicationStatus
}
```

Create `src/admin/admin-job-applications.service.ts`:

```ts
import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ApplicationStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CareersStorageService } from '../careers/careers-storage.service'
import { CareersEmailService } from '../careers/careers-email.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

@Injectable()
export class AdminJobApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CareersStorageService,
    private readonly email: CareersEmailService,
  ) {}

  list(filter: { jobPostingId?: string; status?: ApplicationStatus }) {
    return this.prisma.jobApplication.findMany({
      where: {
        ...(filter.jobPostingId ? { jobPostingId: filter.jobPostingId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { submittedAt: 'desc' },
    })
  }

  async setStatus(id: string, status: ApplicationStatus, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Application not found')

    const application = await this.prisma.jobApplication.update({ where: { id }, data: { status } })
    await this.audit(actor, 'application_set_status', id, status)
    return application
  }

  // Sending the rejection is a distinct action from setting status=REJECTED, never
  // a side effect of it — matches the Astro implementation's explicit design (an
  // admin might mark REJECTED internally before deciding to notify the candidate).
  async reject(id: string, actor: AuthenticatedAdmin) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')
    if (application.status !== ApplicationStatus.REJECTED) {
      throw new BadRequestException('Set status to REJECTED before sending the rejection email')
    }
    if (application.rejectionSentAt) {
      throw new BadRequestException('Rejection email already sent for this application')
    }

    const sent = await this.email.sendRejection({
      to: application.email,
      applicantFirstName: application.firstName,
      jobTitle: application.jobTitleSnapshot,
    })
    if (!sent) {
      throw new BadRequestException('Failed to send rejection email — Mailgun rejected or is unconfigured')
    }

    await this.prisma.jobApplication.update({ where: { id }, data: { rejectionSentAt: new Date() } })
    await this.audit(actor, 'application_reject_sent', id, application.email)
    return { ok: true }
  }

  async remove(id: string, actor: AuthenticatedAdmin) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')

    await this.storage.deleteCv(application.cvKey)
    await this.prisma.jobApplication.delete({ where: { id } })
    await this.audit(actor, 'application_delete', id, application.email)
    return { ok: true }
  }

  async getCv(id: string) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')
    const stream = await this.storage.getCvStream(application.cvKey)
    return { ...stream, filename: application.cvOriginalFilename }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
```

Create `src/admin/admin-job-applications.controller.ts`:

```ts
import { Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards, Body } from '@nestjs/common'
import type { Response } from 'express'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminJobApplicationsService } from './admin-job-applications.service'
import { SetApplicationStatusDto } from './dto/job-application.dto'

@Controller('admin/job-applications')
@UseGuards(JwtAuthGuard)
export class AdminJobApplicationsController {
  constructor(private readonly applications: AdminJobApplicationsService) {}

  @Get()
  list(@Query('jobPostingId') jobPostingId?: string, @Query('status') status?: any) {
    return this.applications.list({ jobPostingId, status })
  }

  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetApplicationStatusDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.setStatus(id, dto.status, admin)
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.reject(id, admin)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.remove(id, admin)
  }

  @Get(':id/cv')
  async downloadCv(@Param('id') id: string, @Res() res: Response) {
    const { body, contentType, filename } = await this.applications.getCv(id)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    ;(body as any).pipe(res)
  }
}
```

Modify `src/admin/admin.module.ts`: import `CareersModule`, add it to `imports`; register
`AdminJobApplicationsController` + `AdminJobApplicationsService`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest admin-job-applications.service.spec.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Full build check and commit**

Run: `npx tsc --noEmit`

```bash
git add src/admin/admin-job-applications.controller.ts src/admin/admin-job-applications.service.ts src/admin/admin-job-applications.service.spec.ts src/admin/dto/job-application.dto.ts src/admin/admin.module.ts src/careers/careers.module.ts
git commit -m "feat(careers): admin application management (status, rejection, CV download, delete)"
```

---

### Task 8: Retention purge cron

**Files:**
- Create: `src/careers/careers-retention.service.ts`
- Create: `src/careers/careers-retention.service.spec.ts`
- Modify: `src/careers/careers.module.ts` (register as provider)

**Interfaces:** none new — consumes `PrismaService`, `CareersStorageService.deleteCv`,
`AlertService` (already global via `CommonModule`).

- [ ] **Step 1: Write the failing test**

Create `src/careers/careers-retention.service.spec.ts`:

```ts
import { CareersRetentionService, RETENTION_DAYS } from './careers-retention.service'

describe('CareersRetentionService', () => {
  let prisma: { jobApplication: { findMany: jest.Mock; delete: jest.Mock } }
  let storage: { deleteCv: jest.Mock }
  let alert: { notify: jest.Mock }
  let service: CareersRetentionService

  beforeEach(() => {
    prisma = { jobApplication: { findMany: jest.fn().mockResolvedValue([]), delete: jest.fn() } }
    storage = { deleteCv: jest.fn().mockResolvedValue(undefined) }
    alert = { notify: jest.fn().mockResolvedValue(undefined) }
    service = new CareersRetentionService(prisma as any, storage as any, alert as any)
  })

  it('queries only applications older than the retention window', async () => {
    await service.purgeExpired()
    const call = prisma.jobApplication.findMany.mock.calls[0][0]
    expect(call.where.submittedAt.lt).toBeInstanceOf(Date)
    const daysAgo = (Date.now() - call.where.submittedAt.lt.getTime()) / (1000 * 60 * 60 * 24)
    expect(Math.round(daysAgo)).toBe(RETENTION_DAYS)
  })

  it('deletes each expired application and its CV, continuing past a single failure', async () => {
    prisma.jobApplication.findMany.mockResolvedValue([
      { id: 'app-1', cvKey: 'cvs/app-1.pdf' },
      { id: 'app-2', cvKey: 'cvs/app-2.pdf' },
    ])
    storage.deleteCv.mockRejectedValueOnce(new Error('spaces down')).mockResolvedValueOnce(undefined)
    prisma.jobApplication.delete.mockResolvedValue({})

    await service.purgeExpired()

    expect(storage.deleteCv).toHaveBeenCalledTimes(2)
    // app-1's CV delete failed — the row must NOT be deleted (would orphan a CV we
    // couldn't confirm was removed); app-2 should still proceed despite app-1's failure.
    expect(prisma.jobApplication.delete).toHaveBeenCalledTimes(1)
    expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-2' } })
    expect(alert.notify).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx jest careers-retention.service.spec.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/careers/careers-retention.service.ts`:

```ts
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { PrismaService } from '../common/prisma.service'
import { CareersStorageService } from './careers-storage.service'
import { AlertService } from '../common/alert.service'

export const RETENTION_DAYS = 365

/**
 * Weekly purge of applications past the retention window, mirroring the Astro
 * implementation's careers-purge.mjs. Per-row try/catch, same reasoning as
 * reconciliation.service.ts: one bad row must never abort the run, and we never
 * delete the DB row unless the CV delete is confirmed — an orphaned CV with no
 * DB record pointing at it is unrecoverable clutter, but a DB row pointing at
 * an already-deleted CV is harmless (getCv would just 404/error on next access).
 */
@Injectable()
export class CareersRetentionService {
  private readonly logger = new Logger(CareersRetentionService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CareersStorageService,
    private readonly alert: AlertService,
  ) {}

  @Cron(CronExpression.EVERY_WEEK)
  async purgeExpired(): Promise<void> {
    const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000)
    const expired = await this.prisma.jobApplication.findMany({
      where: { submittedAt: { lt: cutoff } },
      select: { id: true, cvKey: true },
    })

    let deleted = 0
    let failed = 0
    for (const application of expired) {
      try {
        await this.storage.deleteCv(application.cvKey)
        await this.prisma.jobApplication.delete({ where: { id: application.id } })
        deleted++
      } catch (err) {
        failed++
        this.logger.error(`Failed to purge application ${application.id}`, err as Error)
      }
    }

    if (failed > 0) {
      await this.alert.notify(
        `Careers retention purge: ${deleted} purged, ${failed} failed — see logs for details.`,
        'warning',
      )
    }
  }
}
```

`AlertService.notify(message: string, severity: AlertSeverity = 'warning'): Promise<void>` —
confirmed directly against `src/common/alert.service.ts:57`, a plain string + severity, not an
object (the call above already uses the correct shape).

Modify `src/careers/careers.module.ts`: add `imports: [CommonModule]` (import
`CommonModule` from `../common/common.module`) — `AlertService` is exported globally from
there, and `PaymentsModule` explicitly imports `CommonModule` too even though it's `@Global()`
and already imported once in `AppModule`; match that existing convention rather than relying on
implicit global availability. Add `CareersRetentionService` to `providers`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx jest careers-retention.service.spec.ts`
Expected: PASS (2 tests)

- [ ] **Step 5: Full suite, build check, and commit**

Run: `npm test && npx tsc --noEmit`

```bash
git add src/careers/careers-retention.service.ts src/careers/careers-retention.service.spec.ts src/careers/careers.module.ts
git commit -m "feat(careers): weekly retention purge cron (365 days)"
```

---

## Self-review notes

- **Spec coverage:** schema (1), storage (2), email (3), public read (4), public apply (5),
  admin postings (6), admin applications (7), retention (8) — every piece of the spec's data
  model and sequencing is covered.
- **Type consistency:** `CareersStorageService`/`CareersEmailService` method signatures defined
  in Tasks 2-3 are used identically in Tasks 5 and 7 — no renamed methods across tasks.
- **No placeholders:** every step has runnable code. Task 8's `AlertService.notify(...)` call
  was verified directly against `src/common/alert.service.ts:57` while writing this plan (not
  guessed) — confirmed as `notify(message: string, severity: AlertSeverity)`.
- **Known gap to flag at execution time:** Task 1's schema snippet has a cosmetic alignment
  typo (noted inline) — trivial, but call it out so an implementer doesn't second-guess it.

---

Plan complete and saved to `docs/superpowers/plans/2026-09-16-careers-backend.md`.
