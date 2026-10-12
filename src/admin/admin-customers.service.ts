import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { ListCustomersDto } from './dto/list-customers.dto'
import { auditExport, capRows, CsvColumn, EXPORT_TAKE, toCsv } from './csv-export'

export { csvCell } from './csv-export'

/**
 * Every customer column the console may see. Selected explicitly — never `include` the
 * whole row — so the bcrypt passwordHash (and anything added to the model later) stays
 * out of admin responses and exports by default.
 */
export const CUSTOMER_ADMIN_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  emailVerifiedAt: true,
  over18ConfirmedAt: true,
  termsAcceptedAt: true,
  lastLoginAt: true,
  createdAt: true,
  _count: { select: { beneficiaries: true, orders: true } },
} satisfies Prisma.CustomerSelect

type CustomerExportRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_ADMIN_SELECT }>

const EXPORT_COLUMNS: CsvColumn<CustomerExportRow>[] = [
  ['id', (c) => c.id],
  ['firstName', (c) => c.firstName],
  ['lastName', (c) => c.lastName],
  ['email', (c) => c.email],
  ['phone', (c) => c.phone],
  ['emailVerifiedAt', (c) => c.emailVerifiedAt],
  ['over18ConfirmedAt', (c) => c.over18ConfirmedAt],
  ['termsAcceptedAt', (c) => c.termsAcceptedAt],
  ['lastLoginAt', (c) => c.lastLoginAt],
  ['createdAt', (c) => c.createdAt],
  ['beneficiaries', (c) => c._count.beneficiaries],
  ['orders', (c) => c._count.orders],
]

@Injectable()
export class AdminCustomersService {
  constructor(private readonly prisma: PrismaService) {}

  private where(query: Pick<ListCustomersDto, 'search' | 'verified'>): Prisma.CustomerWhereInput {
    const where: Prisma.CustomerWhereInput = {}
    if (query.verified === true) where.emailVerifiedAt = { not: null }
    if (query.verified === false) where.emailVerifiedAt = null

    const search = query.search?.trim()
    if (search) {
      const parts = search.split(/\s+/)
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search.replace(/[\s()-]/g, '') } },
        { firstName: { contains: search, mode: 'insensitive' } },
        { lastName: { contains: search, mode: 'insensitive' } },
        // "Ada Obi" matches first + last name.
        ...(parts.length > 1
          ? [
              {
                AND: [
                  { firstName: { contains: parts[0], mode: 'insensitive' as const } },
                  { lastName: { contains: parts.slice(1).join(' '), mode: 'insensitive' as const } },
                ],
              },
            ]
          : []),
      ]
    }
    return where
  }

  async list(query: ListCustomersDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const where = this.where(query)
    // Headline counts follow the search but ignore the verified filter, so they stay meaningful while it is set.
    const searchOnly = this.where({ search: query.search })

    const [total, all, verified, customers] = await Promise.all([
      this.prisma.customer.count({ where }),
      this.prisma.customer.count({ where: searchOnly }),
      this.prisma.customer.count({ where: { ...searchOnly, emailVerifiedAt: { not: null } } }),
      this.prisma.customer.findMany({
        where,
        select: CUSTOMER_ADMIN_SELECT,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return {
      data: customers,
      summary: { total: all, verified, unverified: all - verified },
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  async getById(id: string) {
    const customer = await this.prisma.customer.findUnique({
      where: { id },
      select: {
        ...CUSTOMER_ADMIN_SELECT,
        beneficiaries: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            kind: true,
            label: true,
            countryCode: true,
            phone: true,
            meterNumber: true,
            billerId: true,
            email: true,
            createdAt: true,
          },
        },
        orders: {
          orderBy: { createdAt: 'desc' },
          take: 25,
          select: {
            paymentIntentId: true,
            productType: true,
            productName: true,
            status: true,
            chargeAmount: true,
            chargeCurrency: true,
            discountAmount: true,
            createdAt: true,
          },
        },
      },
    })
    if (!customer) throw new NotFoundException('Customer not found')
    return customer
  }

  /** Every matching customer as CSV (no password hash — see CUSTOMER_ADMIN_SELECT). Audited: it is a bulk PII export. */
  async exportCsv(query: Pick<ListCustomersDto, 'search' | 'verified'>, admin: AuthenticatedAdmin): Promise<string> {
    const customers = capRows(
      await this.prisma.customer.findMany({
        where: this.where(query),
        select: CUSTOMER_ADMIN_SELECT,
        orderBy: { createdAt: 'desc' },
        take: EXPORT_TAKE,
      }),
    )
    await auditExport(this.prisma, admin, 'export_customers', customers.length, { search: query.search, verified: query.verified })
    return toCsv(EXPORT_COLUMNS, customers)
  }
}
