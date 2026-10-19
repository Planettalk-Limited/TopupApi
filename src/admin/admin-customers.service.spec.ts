import { NotFoundException } from '@nestjs/common'
import { AdminCustomersService, CUSTOMER_ADMIN_SELECT, csvCell } from './admin-customers.service'

const ADMIN = { id: 'admin-1', email: 'ops@planettalk.com', name: 'Ops', role: 'ADMIN' as const }

function customer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    firstName: 'Ada',
    lastName: 'Obi',
    email: 'ada@example.com',
    phone: '+2348031234567',
    emailVerifiedAt: new Date('2026-10-12T10:00:00Z'),
    over18ConfirmedAt: new Date('2026-10-12T09:59:00Z'),
    termsAcceptedAt: new Date('2026-10-12T09:59:00Z'),
    lastLoginAt: null,
    createdAt: new Date('2026-10-12T09:59:00Z'),
    _count: { beneficiaries: 2, orders: 1 },
    ...overrides,
  }
}

describe('AdminCustomersService', () => {
  let prisma: {
    customer: { count: jest.Mock; findMany: jest.Mock; findUnique: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let service: AdminCustomersService

  beforeEach(() => {
    prisma = {
      customer: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([customer()]),
        findUnique: jest.fn(),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    service = new AdminCustomersService(prisma as never)
  })

  it('never selects the password hash', () => {
    expect(CUSTOMER_ADMIN_SELECT).not.toHaveProperty('passwordHash')
  })

  it('lists with an explicit select, newest first, paginated', async () => {
    const res = await service.list({ page: 2, pageSize: 10 })
    const args = prisma.customer.findMany.mock.calls[0][0]
    expect(args.select).toBe(CUSTOMER_ADMIN_SELECT)
    expect(args).toMatchObject({ orderBy: { createdAt: 'desc' }, skip: 10, take: 10 })
    expect(res.pagination).toEqual({ page: 2, pageSize: 10, total: 1, totalPages: 1 })
  })

  it('searches name, email and phone, and matches "first last"', async () => {
    await service.list({ search: 'Ada Obi' })
    const where = prisma.customer.findMany.mock.calls[0][0].where
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { email: { contains: 'Ada Obi', mode: 'insensitive' } },
        { AND: [{ firstName: { contains: 'Ada', mode: 'insensitive' } }, { lastName: { contains: 'Obi', mode: 'insensitive' } }] },
      ])
    )
  })

  it('filters on verification', async () => {
    await service.list({ verified: false })
    expect(prisma.customer.findMany.mock.calls[0][0].where.emailVerifiedAt).toBeNull()
  })

  it('returns beneficiaries and recent orders on the detail view, still without the hash', async () => {
    prisma.customer.findUnique.mockResolvedValue({ ...customer(), beneficiaries: [], orders: [] })
    await service.getById('c1')
    const select = prisma.customer.findUnique.mock.calls[0][0].select
    expect(select).not.toHaveProperty('passwordHash')
    expect(select.beneficiaries).toBeDefined()
    expect(select.orders.take).toBe(25)
  })

  it('404s an unknown customer', async () => {
    prisma.customer.findUnique.mockResolvedValue(null)
    await expect(service.getById('nope')).rejects.toBeInstanceOf(NotFoundException)
  })

  it('exports CSV without the hash and audits the export', async () => {
    prisma.customer.findMany.mockResolvedValue([customer({ firstName: 'Ada, "Jr"', lastName: '=HYPERLINK("x")' })])
    const csv = await service.exportCsv({}, ADMIN)
    const [header, row] = csv.trim().split('\r\n')
    expect(header).toBe(
      'id,firstName,lastName,email,phone,emailVerifiedAt,over18ConfirmedAt,termsAcceptedAt,lastLoginAt,createdAt,beneficiaries,orders'
    )
    expect(header).not.toMatch(/password/i)
    expect(row).toContain('"Ada, ""Jr"""')
    expect(row).toContain(`"'=HYPERLINK(""x"")"`)
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'export_customers', target: null, result: '1 rows' },
    })
  })

  it('csvCell neutralises formulas and quotes separators', () => {
    expect(csvCell('+447700900000')).toBe('+447700900000')
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell(null)).toBe('')
  })
})
