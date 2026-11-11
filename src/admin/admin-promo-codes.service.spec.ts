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
    promoCode: {
      findMany: jest.Mock
      findUnique: jest.Mock
      create: jest.Mock
      createMany: jest.Mock
      update: jest.Mock
    }
    adminAuditLog: { create: jest.Mock }
  }
  let service: AdminPromoCodesService

  beforeEach(() => {
    prisma = {
      promoCode: {
        findMany: jest.fn().mockResolvedValue([row()]),
        findUnique: jest.fn().mockResolvedValue(row()),
        create: jest.fn(async ({ data }: any) => row({ ...data, _count: undefined })),
        createMany: jest.fn(async ({ data }: any) => ({ count: data.length })),
        update: jest.fn(async ({ data }: any) => row({ ...data })),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    service = new AdminPromoCodesService(prisma as any)
  })

  describe('full-discount (free checkout) codes', () => {
    it('are off unless asked for', async () => {
      await service.create({ code: 'plain', discountType: 'PERCENT', value: 100 } as any, ADMIN)
      expect(prisma.promoCode.create.mock.calls[0][0].data.allowFullDiscount).toBe(false)
    })

    it('can be created and switched on later', async () => {
      await service.create({ code: 'free', discountType: 'PERCENT', value: 100, allowFullDiscount: true } as any, ADMIN)
      expect(prisma.promoCode.create.mock.calls[0][0].data.allowFullDiscount).toBe(true)

      await service.update('promo-1', { allowFullDiscount: true } as any, ADMIN)
      expect(prisma.promoCode.update.mock.calls[0][0].data).toEqual({ allowFullDiscount: true })
    })
  })

  describe('createBatch (single-use codes for a selected group)', () => {
    const batch = (overrides: Record<string, unknown> = {}) =>
      service.createBatch(
        {
          prefix: 'gift',
          count: 25,
          discountType: 'PERCENT',
          value: 100,
          productTypes: ['voucher'],
          allowFullDiscount: true,
          ...overrides,
        } as any,
        ADMIN,
      )

    beforeEach(() => prisma.promoCode.findMany.mockResolvedValue([]))

    it('creates that many distinct, readable, single-use codes', async () => {
      const result = await batch()

      expect(result.count).toBe(25)
      expect(new Set(result.codes).size).toBe(25)
      for (const code of result.codes) expect(code).toMatch(/^GIFT-[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/)
      const rows = prisma.promoCode.createMany.mock.calls[0][0].data
      expect(rows).toHaveLength(25)
      expect(rows[0]).toMatchObject({
        maxRedemptions: 1,
        perCustomerLimit: 1,
        active: true,
        allowFullDiscount: true,
        discountType: 'PERCENT',
        value: 100,
        productTypes: ['voucher'],
      })
    })

    it('leaves out a code that already exists and tops the batch back up', async () => {
      prisma.promoCode.findMany.mockImplementationOnce(async ({ where }: any) => [{ code: where.code.in[0] }])

      const result = await batch({ count: 3 })

      expect(result.count).toBe(3)
      expect(prisma.promoCode.createMany).toHaveBeenCalledTimes(2)
      expect(prisma.promoCode.createMany.mock.calls[0][0].data).toHaveLength(2)
      expect(prisma.promoCode.createMany.mock.calls[1][0].data).toHaveLength(1)
    })

    it('audits the batch once', async () => {
      await batch({ count: 2 })
      expect(prisma.adminAuditLog.create).toHaveBeenCalledTimes(1)
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: { adminId: 'admin-1', action: 'promo_code_batch_create', target: 'GIFT', result: '2 single-use codes' },
      })
    })

    it('applies the same coherence rules as a single code', async () => {
      await expect(batch({ value: 150 })).rejects.toBeInstanceOf(BadRequestException)
      expect(prisma.promoCode.createMany).not.toHaveBeenCalled()
    })
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
