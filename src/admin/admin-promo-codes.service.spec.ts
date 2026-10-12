import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { AdminPromoCodesService } from './admin-promo-codes.service'

const ADMIN = { id: 'admin-1', email: 'ops@planettalk.com', name: 'Ops', role: 'ADMIN' as const }
const D = (n: number) => new Prisma.Decimal(n)

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'WELCOME10',
    description: null,
    discountType: 'PERCENT',
    value: D(10),
    maxDiscountGbp: D(5),
    minOrderGbp: null,
    productTypes: [],
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    perCustomerLimit: 1,
    active: true,
    createdAt: new Date('2026-10-12T00:00:00Z'),
    updatedAt: new Date('2026-10-12T00:00:00Z'),
    _count: { redemptions: 3 },
    ...overrides,
  }
}

describe('AdminPromoCodesService', () => {
  let prisma: {
    promoCode: { findMany: jest.Mock; findUnique: jest.Mock; create: jest.Mock; update: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let service: AdminPromoCodesService

  beforeEach(() => {
    prisma = {
      promoCode: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn(async ({ data }: any) => row({ ...data, _count: undefined })),
        update: jest.fn(async ({ data }: any) => row({ ...data })),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    service = new AdminPromoCodesService(prisma as any)
  })

  it('lists codes with plain-number money fields and a redemption count', async () => {
    const [first] = await service.list()
    expect(first).toMatchObject({ code: 'WELCOME10', value: 10, maxDiscountGbp: 5, minOrderGbp: null, redemptionCount: 3 })
  })

  it('creates an upper-cased code and audits it', async () => {
    const created = await service.create(
      { code: 'summer-5', discountType: 'FIXED_GBP', value: 2, productTypes: ['topup'] } as any,
      ADMIN,
    )

    expect(prisma.promoCode.create.mock.calls[0][0].data).toMatchObject({
      code: 'SUMMER-5',
      discountType: 'FIXED_GBP',
      value: 2,
      productTypes: ['topup'],
      perCustomerLimit: 1,
      active: true,
    })
    expect(created.code).toBe('SUMMER-5')
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ adminId: 'admin-1', action: 'promo_code_create' }),
    })
  })

  it('rejects a percentage above 100 and an end before the start', async () => {
    await expect(service.create({ code: 'X1', discountType: 'PERCENT', value: 150 } as any, ADMIN)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(
      service.create(
        {
          code: 'X2',
          discountType: 'PERCENT',
          value: 10,
          startsAt: '2026-11-01T00:00:00Z',
          endsAt: '2026-10-01T00:00:00Z',
        } as any,
        ADMIN,
      ),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('409 on a duplicate code', async () => {
    prisma.promoCode.create.mockRejectedValue(Object.assign(new Error('dup'), { code: 'P2002' }))
    await expect(service.create({ code: 'WELCOME10', discountType: 'PERCENT', value: 10 } as any, ADMIN)).rejects.toBeInstanceOf(
      ConflictException,
    )
  })

  it('updates (e.g. deactivates) a code and audits it; 404 for unknown ids', async () => {
    await service.update('promo-1', { active: false } as any, ADMIN)
    expect(prisma.promoCode.update).toHaveBeenCalledWith({
      where: { id: 'promo-1' },
      data: { active: false },
      include: { _count: { select: { redemptions: true } } },
    })
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: 'promo_code_update', target: 'promo-1' }),
    })

    prisma.promoCode.findUnique.mockResolvedValue(null)
    await expect(service.update('nope', { active: false } as any, ADMIN)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('validates a PATCH against the merged result (percent cap applies to the existing type)', async () => {
    await expect(service.update('promo-1', { value: 120 } as any, ADMIN)).rejects.toBeInstanceOf(BadRequestException)
  })
})
