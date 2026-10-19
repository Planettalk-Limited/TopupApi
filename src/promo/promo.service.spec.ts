import { Prisma } from '@prisma/client'
import { computePromoDiscount, PromoError, PromoService } from './promo.service'
import { recordPromoRedemption, PromoRedemptionLimitError } from './promo-redemption'

const D = (n: number) => new Prisma.Decimal(n)

function promo(overrides: Record<string, unknown> = {}) {
  return {
    id: 'promo-1',
    code: 'WELCOME10',
    description: null,
    discountType: 'PERCENT',
    value: D(10),
    maxDiscountGbp: null,
    minOrderGbp: null,
    productTypes: [] as string[],
    startsAt: null,
    endsAt: null,
    maxRedemptions: null,
    perCustomerLimit: 1,
    active: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any
}

describe('computePromoDiscount', () => {
  it('takes a percentage of the subtotal, rounded to the currency', () => {
    expect(computePromoDiscount(promo({ value: D(10) }), 13.37, 'gbp')).toEqual({ discount: 1.33, total: 12.04 })
  })

  it('converts a FIXED_GBP discount into the charge currency', () => {
    const { discount } = computePromoDiscount(promo({ discountType: 'FIXED_GBP', value: D(2) }), 13, 'gbp')
    expect(discount).toBe(2)
    const usd = computePromoDiscount(promo({ discountType: 'FIXED_GBP', value: D(2) }), 13, 'usd')
    expect(usd.discount).toBeGreaterThan(2) // £2 is worth more than $2
  })

  it('caps a percentage discount at maxDiscountGbp', () => {
    expect(computePromoDiscount(promo({ value: D(50), maxDiscountGbp: D(3) }), 20, 'gbp').discount).toBe(3)
  })

  it('never discounts the whole subtotal: the total is floored at Stripe’s minimum charge', () => {
    // £0.30 is Stripe's GBP minimum.
    expect(computePromoDiscount(promo({ discountType: 'FIXED_GBP', value: D(50) }), 5, 'gbp')).toEqual({
      discount: 4.7,
      total: 0.3,
    })
    expect(computePromoDiscount(promo({ value: D(100) }), 5, 'gbp').total).toBe(0.3)
  })

  it('discount + total always add back up to the subtotal', () => {
    for (const subtotal of [3.33, 7.01, 13.37, 19.99]) {
      const { discount, total } = computePromoDiscount(promo({ value: D(15) }), subtotal, 'gbp')
      expect(Math.round((discount + total) * 100)).toBe(Math.round(subtotal * 100))
    }
  })
})

describe('PromoService.quote', () => {
  let prisma: {
    promoCode: { findUnique: jest.Mock }
    promoRedemption: { count: jest.Mock }
  }
  let service: PromoService

  const quote = (overrides: Record<string, unknown> = {}) =>
    service.quote({
      code: ' welcome10 ',
      customerId: 'cust-1',
      productType: 'topup',
      subtotal: 13,
      currency: 'gbp',
      ...overrides,
    } as any)

  async function reason(p: Promise<unknown>): Promise<string | undefined> {
    const error = await p.catch((e) => e)
    expect(error).toBeInstanceOf(PromoError)
    return (error as PromoError).code
  }

  beforeEach(() => {
    prisma = {
      promoCode: { findUnique: jest.fn().mockResolvedValue(promo()) },
      promoRedemption: { count: jest.fn().mockResolvedValue(0) },
    }
    service = new PromoService(prisma as any)
  })

  it('looks the code up upper-cased and returns the discounted total', async () => {
    const result = await quote()
    expect(prisma.promoCode.findUnique).toHaveBeenCalledWith({ where: { code: 'WELCOME10' } })
    expect(result).toEqual({ promo: expect.objectContaining({ id: 'promo-1' }), discount: 1.3, total: 11.7 })
  })

  it('rejects unknown, inactive, not-yet-started and expired codes', async () => {
    prisma.promoCode.findUnique.mockResolvedValueOnce(null)
    expect(await reason(quote())).toBe('PROMO_NOT_FOUND')

    prisma.promoCode.findUnique.mockResolvedValueOnce(promo({ active: false }))
    expect(await reason(quote())).toBe('PROMO_INACTIVE')

    prisma.promoCode.findUnique.mockResolvedValueOnce(promo({ startsAt: new Date(Date.now() + 60_000) }))
    expect(await reason(quote())).toBe('PROMO_NOT_STARTED')

    prisma.promoCode.findUnique.mockResolvedValueOnce(promo({ endsAt: new Date(Date.now() - 60_000) }))
    expect(await reason(quote())).toBe('PROMO_EXPIRED')
  })

  it('rejects a code that is not valid for the product type', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(promo({ productTypes: ['giftcard'] }))
    expect(await reason(quote())).toBe('PROMO_NOT_APPLICABLE')
    await expect(quote({ productType: 'giftcard' })).resolves.toHaveProperty('discount')
  })

  it('rejects an order below the minimum spend', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(promo({ minOrderGbp: D(15) }))
    expect(await reason(quote())).toBe('PROMO_MIN_ORDER')
  })

  it('rejects a code that has hit its total redemption cap', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(promo({ maxRedemptions: 100 }))
    prisma.promoRedemption.count.mockImplementation(async ({ where }: any) => (where.customerId ? 0 : 100))
    expect(await reason(quote())).toBe('PROMO_EXHAUSTED')
  })

  it('enforces the per-customer limit', async () => {
    prisma.promoCode.findUnique.mockResolvedValue(promo({ perCustomerLimit: 2 }))
    prisma.promoRedemption.count.mockImplementation(async ({ where }: any) => (where.customerId === 'cust-1' ? 2 : 0))
    expect(await reason(quote())).toBe('PROMO_ALREADY_USED')
    await expect(quote({ customerId: 'cust-2' })).resolves.toHaveProperty('discount')
  })
})

describe('recordPromoRedemption', () => {
  function tx(opts: { promo?: any; total?: number; mine?: number } = {}) {
    return {
      $queryRaw: jest.fn().mockResolvedValue(opts.promo === null ? [] : [{ id: 'promo-1' }]),
      promoCode: { findUnique: jest.fn().mockResolvedValue(opts.promo === undefined ? promo() : opts.promo) },
      promoRedemption: {
        count: jest.fn(async ({ where }: any) => (where.customerId ? (opts.mine ?? 0) : (opts.total ?? 0))),
        create: jest.fn().mockResolvedValue({ id: 'red-1' }),
      },
    }
  }
  const params = {
    promoCodeId: 'promo-1',
    customerId: 'cust-1',
    orderId: 'order-1',
    discountAmount: 1.3,
    currency: 'GBP',
  }

  it('locks the promo row, re-checks the limits and records the redemption', async () => {
    const t = tx()
    await recordPromoRedemption(t as any, params)
    expect(t.$queryRaw).toHaveBeenCalledTimes(1)
    expect(t.promoRedemption.create).toHaveBeenCalledWith({ data: params })
  })

  it('refuses when the per-customer limit was reached since the intent was created', async () => {
    const t = tx({ mine: 1 })
    await expect(recordPromoRedemption(t as any, params)).rejects.toBeInstanceOf(PromoRedemptionLimitError)
    expect(t.promoRedemption.create).not.toHaveBeenCalled()
  })

  it('refuses when the global cap was reached since the intent was created', async () => {
    const t = tx({ promo: promo({ maxRedemptions: 5 }), total: 5 })
    await expect(recordPromoRedemption(t as any, params)).rejects.toBeInstanceOf(PromoRedemptionLimitError)
  })
})
