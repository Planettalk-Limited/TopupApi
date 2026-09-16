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
