import 'dotenv/config'
import { defineConfig, env } from 'prisma/config'

// Prisma 7 CLI config. The runtime uses the PrismaPg driver adapter (see
// src/common/prisma.service.ts); this datasource url is only for CLI commands
// like `prisma migrate deploy` / `prisma studio`.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
})
