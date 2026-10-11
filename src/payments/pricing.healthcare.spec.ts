import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import { MARKUP, PricingError, PricingService } from './pricing.service'
import { convertCurrency } from './static-fx'
import type { HealthcareFulfillmentOrder } from './payments.types'

const FX = 100 / 0.07 // NGN per USD for product 1951

function order(overrides: Partial<HealthcareFulfillmentOrder> = {}): HealthcareFulfillmentOrder {
  return {
    productType: 'healthcare',
    countryCode: 'NG',
    productId: 1951,
    providerAmount: 1824,
    providerCurrency: 'NGN',
    email: 'buyer@example.com',
    details: {
      pharmacyCode: 'WHP10431Test',
      isDelivery: true,
      buyerPhone: '+447700900000',
      patient: { firstName: 'Ada', lastName: 'Obi', gender: 'Female', phone: '08012345678', address: 'Ikeja' },
      drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, unitPrice: 912 }],
    },
    ...overrides,
  }
}

function makePricing(findDrug: jest.Mock) {
  const healthcare = { findDrug, getProductFxRate: jest.fn().mockResolvedValue(FX) } as any
  return { pricing: new PricingService({} as any, {} as any, healthcare), healthcare }
}

const live = (price: number) => jest.fn().mockResolvedValue({ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', price })

describe('PricingService — healthcare', () => {
  it('charges NGN total / product fx (USD cost) x markup, in the charge currency', async () => {
    const { pricing } = makePricing(live(912))
    const expected = Math.round(convertCurrency((1824 / FX) * MARKUP, 'USD', 'gbp') * 100) / 100

    await expect(pricing.priceOrder(order(), 'gbp')).resolves.toBe(expected)
  })

  it('is not held to the global £3 minimum (a single syrup is well below it)', async () => {
    const { pricing } = makePricing(live(912))
    const small = order({
      providerAmount: 912,
      details: { ...order().details!, drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 1, unitPrice: 912 }] },
    })
    await expect(pricing.priceOrder(small, 'gbp')).resolves.toBeGreaterThan(0)
  })

  it('accepts a live price that has dropped — the customer pays what they were shown', async () => {
    const { pricing } = makePricing(live(800))
    await expect(pricing.priceOrder(order(), 'gbp')).resolves.toBeGreaterThan(0)
  })

  it('refuses (422) when a medication has gone up in price since checkout', async () => {
    const { pricing } = makePricing(live(1000))
    await expect(pricing.priceOrder(order(), 'gbp')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('refuses (422) when a medication is no longer listed', async () => {
    const { pricing } = makePricing(jest.fn().mockResolvedValue(null))
    await expect(pricing.priceOrder(order(), 'gbp')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('treats a 400 from the search as delisted, not as an outage', async () => {
    const { pricing } = makePricing(jest.fn().mockRejectedValue(new BadRequestException('bad query')))
    await expect(pricing.priceOrder(order(), 'gbp')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('lets an upstream outage propagate (not a PricingError) so fulfilment can retry', async () => {
    const { pricing } = makePricing(jest.fn().mockRejectedValue(new ServiceUnavailableException('down')))
    const err = await pricing.priceOrder(order(), 'gbp').catch((e) => e)
    expect(err).toBeInstanceOf(ServiceUnavailableException)
    expect(err).not.toBeInstanceOf(PricingError)
  })

  it('enforces the healthcare per-order cap', async () => {
    const { pricing } = makePricing(live(912))
    // ~NGN 500k is far above £50.
    await expect(pricing.chargeForHealthcareTotal(500_000, 1951, 'gbp')).rejects.toBeInstanceOf(PricingError)
  })

  it('refuses an order with no medications', async () => {
    const { pricing } = makePricing(live(912))
    await expect(pricing.priceOrder(order({ details: undefined }), 'gbp')).rejects.toBeInstanceOf(PricingError)
  })
})
