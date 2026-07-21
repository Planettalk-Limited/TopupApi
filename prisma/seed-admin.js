/**
 * Seed / reset the first admin user — PLAIN JS version for the production
 * container (which has no ts-node/dotenv, only runtime deps).
 *
 * Usage inside the running container:
 *   docker compose exec app node prisma/seed-admin.js
 *
 * Reads ADMIN_SEED_EMAIL / ADMIN_SEED_PASSWORD / ADMIN_SEED_NAME / ADMIN_SEED_ROLE
 * from the environment (already provided via the container's env_file).
 * Idempotent: upserts by email, re-hashing the password each run (also usable
 * to reset a forgotten password). The TypeScript sibling (seed-admin.ts) stays
 * for local dev via `npm run seed:admin`.
 */
const { PrismaClient, AdminRole } = require('@prisma/client')
const { PrismaPg } = require('@prisma/adapter-pg')
const { Pool } = require('pg')
const bcrypt = require('bcrypt')

async function main() {
  const email = (process.env.ADMIN_SEED_EMAIL || '').toLowerCase()
  const password = process.env.ADMIN_SEED_PASSWORD
  const name = process.env.ADMIN_SEED_NAME || 'Admin'
  const role = process.env.ADMIN_SEED_ROLE || AdminRole.SUPERADMIN

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
