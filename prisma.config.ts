import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7 CLI config. Prisma 7 forbids `url` in schema.prisma and no longer
// auto-loads .env, so the datasource url for Migrate lives here (the runtime
// itself uses the PrismaPg driver adapter — see src/common/prisma.service.ts).
// This file ships in the production image too (see Dockerfile) so the
// container's `prisma migrate deploy` on boot can resolve DATABASE_URL.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
