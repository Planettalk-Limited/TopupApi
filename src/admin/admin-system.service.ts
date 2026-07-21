import { Injectable } from '@nestjs/common'
import { Prisma, Provider } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { ListAuditLogDto, ListProviderLogsDto } from './dto/list-logs.dto'

/**
 * System / observability views for the admin console: provider health derived
 * from the ProviderCallLog audit trail (no live vendor pings — safe to hit
 * freely), the raw provider call log, and the admin audit log.
 */
@Injectable()
export class AdminSystemService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Per-provider health computed from the last 24h of call logs: success rate,
   * average latency, last call time, and last error. Avoids making real vendor
   * calls (buhibab has no sandbox) — the audit trail is enough to spot outages.
   */
  async providerHealth() {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    const providers = Object.values(Provider)

    const results = await Promise.all(
      providers.map(async (provider) => {
        const [calls, lastCall, lastError] = await Promise.all([
          this.prisma.providerCallLog.findMany({
            where: { provider, createdAt: { gte: since } },
            select: { success: true, latencyMs: true },
          }),
          this.prisma.providerCallLog.findFirst({
            where: { provider },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, success: true, endpoint: true },
          }),
          this.prisma.providerCallLog.findFirst({
            where: { provider, success: false },
            orderBy: { createdAt: 'desc' },
            select: { createdAt: true, error: true, endpoint: true },
          }),
        ])

        const total = calls.length
        const ok = calls.filter((c) => c.success).length
        const avgLatency =
          total > 0
            ? Math.round(calls.reduce((s, c) => s + (c.latencyMs ?? 0), 0) / total)
            : null

        return {
          provider,
          calls24h: total,
          successRate: total > 0 ? Math.round((ok / total) * 100) : null,
          avgLatencyMs: avgLatency,
          lastCallAt: lastCall?.createdAt ?? null,
          lastCallOk: lastCall?.success ?? null,
          lastError: lastError
            ? { at: lastError.createdAt, endpoint: lastError.endpoint, message: lastError.error }
            : null,
        }
      }),
    )

    return { providers: results }
  }

  async providerLogs(query: ListProviderLogsDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 50
    const where: Prisma.ProviderCallLogWhereInput = {}
    if (query.provider) where.provider = query.provider
    if (query.success === 'true') where.success = true
    if (query.success === 'false') where.success = false

    const [total, data] = await Promise.all([
      this.prisma.providerCallLog.count({ where }),
      this.prisma.providerCallLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return {
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  async auditLog(query: ListAuditLogDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 50
    const where: Prisma.AdminAuditLogWhereInput = {}
    if (query.action) where.action = query.action

    const [total, data] = await Promise.all([
      this.prisma.adminAuditLog.count({ where }),
      this.prisma.adminAuditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: { admin: { select: { email: true, name: true } } },
      }),
    ])

    return {
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }
}
