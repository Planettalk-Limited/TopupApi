/**
 * Seed / reset the first admin user.
 *
 * Usage (from TopupApi root, with DATABASE_URL set):
 *   ADMIN_SEED_EMAIL=you@planettalk.com ADMIN_SEED_PASSWORD='strong-pass' \
 *   ADMIN_SEED_NAME='Your Name' npx ts-node prisma/seed-admin.ts
 *
 * Idempotent: upserts by email, re-hashing the password each run so it can
 * also be used to reset a forgotten password.
 */
import { PrismaClient, AdminRole } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import * as bcrypt from 'bcrypt'

async function main() {
  const email = process.env.ADMIN_SEED_EMAIL?.toLowerCase()
  const password = process.env.ADMIN_SEED_PASSWORD
  const name = process.env.ADMIN_SEED_NAME ?? 'Admin'
  const role = (process.env.ADMIN_SEED_ROLE as AdminRole) ?? AdminRole.SUPERADMIN

  if (!email || !password) {
    throw new Error('ADMIN_SEED_EMAIL and ADMIN_SEED_PASSWORD are required')
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: false })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

  const passwordHash = await bcrypt.hash(password, 12)
  const admin = await prisma.adminUser.upsert({
    where: { email },
    update: { passwordHash, name, role, active: true },
    create: { email, passwordHash, name, role },
    select: { id: true, email: true, role: true },
  })

  console.log(`Seeded admin: ${admin.email} (${admin.role}) [${admin.id}]`)
  await prisma.$disconnect()
  await pool.end()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
