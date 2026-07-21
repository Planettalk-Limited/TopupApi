import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  constructor(configService: ConfigService) {
    const connectionString = configService.get<string>('DATABASE_URL')

    // This app only ever talks to the self-hosted `postgres` container over
    // the private Docker network (see docker-compose.yml) — never a public
    // endpoint — so plain TCP is correct here. If this ever needs to reach a
    // remote managed database, add a proper CA cert (`ssl: { ca }`), don't
    // set `rejectUnauthorized: false`.
    const pool = new Pool({ connectionString, ssl: false })
    const adapter = new PrismaPg(pool)
    super({ adapter })
  }

  async onModuleInit() {
    await this.$connect()
  }

  async onModuleDestroy() {
    await this.$disconnect()
  }
}
