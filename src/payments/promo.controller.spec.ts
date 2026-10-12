import { BadRequestException } from '@nestjs/common'
import { PromoError } from '../promo/promo.service'
import { PromoController } from './promo.controller'

const CUSTOMER = { id: 'cust-1', email: 'ada@example.com', firstName: 'Ada', lastName: 'Obi', phone: '+447860980321' }
const order = {
  productType: 'topup' as const,
  countryCode: 'GB',
  operatorId: 1,
  recipientPhone: '+447860980321',
  providerAmount: 10,
  providerCurrency: 'GBP',
  useLocalAmount: false,
}

describe('PromoController.validate', () => {
  let pricing: { priceOrder: jest.Mock }
  let promo: { quote: jest.Mock }
  let controller: PromoController

  beforeEach(() => {
    pricing = { priceOrder: jest.fn().mockResolvedValue(13) }
    promo = {
      quote: jest.fn().mockResolvedValue({ promo: { id: 'promo-1', code: 'WELCOME10' }, discount: 1.3, total: 11.7 }),
    }
    controller = new PromoController(pricing as any, {} as any, promo as any)
  })

  it('prices the order on the server, exactly like create-intent, and returns the discounted total', async () => {
    const result = await controller.validate(CUSTOMER, { code: ' welcome10 ', currency: 'gbp', order } as any)

    expect(pricing.priceOrder).toHaveBeenCalledWith(expect.objectContaining({ operatorId: 1 }), 'gbp')
    expect(promo.quote).toHaveBeenCalledWith({
      code: ' welcome10 ',
      customerId: 'cust-1',
      productType: 'topup',
      subtotal: 13,
      currency: 'gbp',
    })
    expect(result).toEqual({
      valid: true,
      code: 'WELCOME10',
      subtotal: 13,
      discount: 1.3,
      total: 11.7,
      currency: 'GBP',
    })
  })

  it('reports an unusable code as valid:false with the reason, at full price', async () => {
    promo.quote.mockRejectedValue(new PromoError('PROMO_ALREADY_USED', 'You have already used this promo code'))

    const result = await controller.validate(CUSTOMER, { code: 'welcome10', currency: 'gbp', order } as any)

    expect(result).toEqual({
      valid: false,
      code: 'WELCOME10',
      subtotal: 13,
      discount: 0,
      total: 13,
      currency: 'GBP',
      message: 'You have already used this promo code',
      reason: 'PROMO_ALREADY_USED',
    })
  })

  it('surfaces order/pricing errors as HTTP errors (same as create-intent)', async () => {
    await expect(
      controller.validate(CUSTOMER, { code: 'X', currency: 'gbp', order: { ...order, recipientPhone: '' } } as any),
    ).rejects.toBeInstanceOf(BadRequestException)
    expect(promo.quote).not.toHaveBeenCalled()
  })

  it('is customer-only and rate limited', () => {
    const guards = Reflect.getMetadata('__guards__', PromoController) as unknown[]
    expect(guards.map((g: any) => g.name)).toContain('CustomerAuthGuard')
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', PromoController.prototype.validate)).toBeDefined()
  })
})
