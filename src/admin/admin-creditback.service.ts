import { Injectable, NotFoundException } from '@nestjs/common'
import { CreditbackClaim, Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { ListCreditbackDto } from './dto/list-creditback.dto'
import { UpdateCreditbackStatusDto } from './dto/update-creditback-status.dto'
import { auditExport, capRows, CsvColumn, EXPORT_TAKE, toCsv } from './csv-export'

type CreditbackFilters = Pick<ListCreditbackDto, 'status' | 'countryCode' | 'search'>

const CREDITBACK_EXPORT_COLUMNS: CsvColumn<CreditbackClaim>[] = [
  ['createdAt', (c) => c.createdAt],
  ['id', (c) => c.id],
  ['status', (c) => c.status],
  ['email', (c) => c.email],
  ['phone', (c) => c.phone],
  ['countryCode', (c) => c.countryCode],
  ['transactionValue', (c) => c.transactionValue],
  ['transactionCurrency', (c) => c.transactionCurrency],
  ['transactionId', (c) => c.transactionId],
  ['locale', (c) => c.locale],
]

/**
 * Admin view over the PlanetTalk Creditback claim leads. Ops uses this to work
 * through NEW claims: match each against a PlanetTalk app account, apply the
 * credit, then mark CREDITED (or REJECTED). Every status change is audited.
 */
@Injectable()
export class AdminCreditbackService {
  constructor(private readonly prisma: PrismaService) {}

  private where(query: CreditbackFilters): Prisma.CreditbackClaimWhereInput {
    const where: Prisma.CreditbackClaimWhereInput = {}
    if (query.status) where.status = query.status
    if (query.countryCode) where.countryCode = query.countryCode

    const search = query.search?.trim()
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { transactionId: { contains: search, mode: 'insensitive' } },
      ]
    }
    return where
  }

  async list(query: ListCreditbackDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const where = this.where(query)

    const [total, data] = await Promise.all([
      this.prisma.creditbackClaim.count({ where }),
      this.prisma.creditbackClaim.findMany({
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

  /** Every matching claim as CSV, same filters as the list. Audited: emails and phones. */
  async exportCsv(query: CreditbackFilters, admin: AuthenticatedAdmin): Promise<string> {
    const claims = capRows(
      await this.prisma.creditbackClaim.findMany({ where: this.where(query), orderBy: { createdAt: 'desc' }, take: EXPORT_TAKE }),
    )
    const { status, countryCode, search } = query
    await auditExport(this.prisma, admin, 'export_creditback', claims.length, { status, countryCode, search })
    return toCsv(CREDITBACK_EXPORT_COLUMNS, claims)
  }

  async updateStatus(id: string, dto: UpdateCreditbackStatusDto, admin: AuthenticatedAdmin) {
    const existing = await this.prisma.creditbackClaim.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Claim not found')

    const updated = await this.prisma.creditbackClaim.update({
      where: { id },
      data: { status: dto.status },
    })

    await this.prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        action: 'creditback_status_change',
        target: id,
        result: `${existing.status} -> ${dto.status}`,
      },
    })

    return updated
  }
}
