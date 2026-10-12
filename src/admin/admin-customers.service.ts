import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { ListCustomersDto } from './dto/list-customers.dto'

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

const EXPORT_COLUMNS = [
  'id',
  'firstName',
  'lastName',
  'email',
  'phone',
  'emailVerifiedAt',
  'over18ConfirmedAt',
  'termsAcceptedAt',
  'lastLoginAt',
  'createdAt',
  'beneficiaries',
  'orders',
] as const

/** RFC 4180 cell, with a leading quote on formula-looking values so Excel won't execute them. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : String(value)
  // E.164 phones (+ then digits only) can't carry a formula, so they are left readable.
  if (/^[=+\-@\t\r]/.test(text) && !/^\+\d+$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

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
    const customers = await this.prisma.customer.findMany({
      where: this.where(query),
      select: CUSTOMER_ADMIN_SELECT,
      orderBy: { createdAt: 'desc' },
    })

    try {
      await this.prisma.adminAuditLog.create({
        data: { adminId: admin.id, action: 'export_customers', target: null, result: `${customers.length} rows` },
      })
    } catch {
      // best-effort, as elsewhere in the console
    }

    const lines = [EXPORT_COLUMNS.join(',')]
    for (const c of customers) {
      const row: Record<(typeof EXPORT_COLUMNS)[number], unknown> = {
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        email: c.email,
        phone: c.phone,
        emailVerifiedAt: c.emailVerifiedAt,
        over18ConfirmedAt: c.over18ConfirmedAt,
        termsAcceptedAt: c.termsAcceptedAt,
        lastLoginAt: c.lastLoginAt,
        createdAt: c.createdAt,
        beneficiaries: c._count.beneficiaries,
        orders: c._count.orders,
      }
      lines.push(EXPORT_COLUMNS.map((col) => csvCell(row[col])).join(','))
    }
    return lines.join('\r\n') + '\r\n'
  }
}
