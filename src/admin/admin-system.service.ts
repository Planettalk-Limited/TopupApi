import { Injectable } from '@nestjs/common'
import { AdminAuditLog, Prisma, Provider, ProviderCallLog } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { ListAuditLogDto, ListProviderLogsDto } from './dto/list-logs.dto'
import { auditExport, capRows, CsvColumn, EXPORT_TAKE, toCsv } from './csv-export'

const PROVIDER_LOG_EXPORT_COLUMNS: CsvColumn<ProviderCallLog>[] = [
  ['createdAt', (l) => l.createdAt],
  ['provider', (l) => l.provider],
  ['method', (l) => l.method],
  ['endpoint', (l) => l.endpoint],
  ['success', (l) => l.success],
  ['responseStatus', (l) => l.responseStatus],
  ['latencyMs', (l) => l.latencyMs],
  ['orderId', (l) => l.orderId],
  ['requestSummary', (l) => l.requestSummary],
  ['error', (l) => l.error],
]

type AuditRow = AdminAuditLog & { admin: { email: string; name: string } | null }

const AUDIT_EXPORT_COLUMNS: CsvColumn<AuditRow>[] = [
  ['createdAt', (a) => a.createdAt],
  ['adminEmail', (a) => a.admin?.email],
  ['adminName', (a) => a.admin?.name],
  ['action', (a) => a.action],
  ['target', (a) => a.target],
  ['result', (a) => a.result],
]

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

  private providerLogWhere(query: Pick<ListProviderLogsDto, 'provider' | 'success'>): Prisma.ProviderCallLogWhereInput {
    const where: Prisma.ProviderCallLogWhereInput = {}
    if (query.provider) where.provider = query.provider
    if (query.success === 'true') where.success = true
    if (query.success === 'false') where.success = false
    return where
  }

  async providerLogs(query: ListProviderLogsDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 50
    const where = this.providerLogWhere(query)

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

  private auditWhere(query: Pick<ListAuditLogDto, 'action'>): Prisma.AdminAuditLogWhereInput {
    return query.action ? { action: query.action } : {}
  }

  async auditLog(query: ListAuditLogDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 50
    const where = this.auditWhere(query)

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

  async exportProviderLogs(query: Pick<ListProviderLogsDto, 'provider' | 'success'>, admin: AuthenticatedAdmin): Promise<string> {
    const logs = capRows(
      await this.prisma.providerCallLog.findMany({
        where: this.providerLogWhere(query),
        orderBy: { createdAt: 'desc' },
        take: EXPORT_TAKE,
      }),
    )
    await auditExport(this.prisma, admin, 'export_provider_logs', logs.length, { provider: query.provider, success: query.success })
    return toCsv(PROVIDER_LOG_EXPORT_COLUMNS, logs)
  }

  async exportAuditLog(query: Pick<ListAuditLogDto, 'action'>, admin: AuthenticatedAdmin): Promise<string> {
    const rows = capRows(
      await this.prisma.adminAuditLog.findMany({
        where: this.auditWhere(query),
        orderBy: { createdAt: 'desc' },
        take: EXPORT_TAKE,
        include: { admin: { select: { email: true, name: true } } },
      }),
    )
    // Audited after the read, so the export does not list itself.
    await auditExport(this.prisma, admin, 'export_audit_log', rows.length, { action: query.action })
    return toCsv(AUDIT_EXPORT_COLUMNS, rows)
  }
}
