import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service'

@Injectable()
export class HealthService {
  constructor(private readonly prisma: PrismaService) {}

  async check() {
    const result = {
      status: 'ok' as 'ok' | 'degraded',
      timestamp: new Date().toISOString(),
      service: 'topup-api',
      database: 'unknown' as string,
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`
      result.database = 'ok'
    } catch (error) {
      result.status = 'degraded'
      result.database = error instanceof Error ? error.message : 'error'
    }

    return result
  }
}
