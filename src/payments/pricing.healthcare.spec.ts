import { BadRequestException, ServiceUnavailableException } from '@nestjs/common'
import {
  HEALTHCARE_MIN_NGN,
  PricingError,
  PricingService,
  VOUCHER_MARKUP,
  healthcareBasketShortfall,
} from './pricing.service'
import { convertCurrency } from './static-fx'
import type { HealthcareFulfillmentOrder } from './payments.types'

const FX = 100 / 0.07 // NGN per USD for product 1951

function order(overrides: Partial<HealthcareFulfillmentOrder> = {}): HealthcareFulfillmentOrder {
  return {
    productType: 'healthcare',
    countryCode: 'NG',
    productId: 1951,
    providerAmount: 6384,
    providerCurrency: 'NGN',
    email: 'buyer@example.com',
    details: {
      isDelivery: true,
      buyerPhone: '+447700900000',
      patient: { firstName: 'Ada', lastName: 'Obi', gender: 'Female', phone: '08012345678', address: 'Ikeja' },
      drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 7, unitPrice: 912 }],
    },
    ...overrides,
  }
}

function makePricing(findDrug: jest.Mock) {
  const healthcare = { findDrug, getProductFxRate: jest.fn().mockResolvedValue(FX) } as any
  return { pricing: new PricingService({} as any, {} as any, healthcare, {} as any), healthcare }
}

const live = (price: number) => jest.fn().mockResolvedValue({ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', price })

describe('PricingService — healthcare', () => {
  it('charges NGN total / product fx (USD cost) x the groceries voucher markup, in the charge currency', async () => {
    const { pricing } = makePricing(live(912))
    const expected = Math.round(convertCurrency((6384 / FX) * VOUCHER_MARKUP, 'USD', 'gbp') * 100) / 100

    await expect(pricing.priceOrder(order(), 'gbp')).resolves.toBe(expected)
  })

  it(`accepts a basket of exactly the NGN minimum (${HEALTHCARE_MIN_NGN})`, async () => {
    const { pricing } = makePricing(live(1100))
    const atMin = order({
      providerAmount: 5500,
      details: { ...order().details!, drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 5, unitPrice: 1100 }] },
    })
    await expect(pricing.priceOrder(atMin, 'gbp')).resolves.toBeGreaterThan(0)
  })

  // Stripe's fixed fee eats a small basket (a N300 pack of paracetamol), so the business set
  // a N5,500 floor on 2026-11-17. Enforced here, not only in the UI, as checkout re-prices.
  it('refuses (422) a basket below the NGN minimum', async () => {
    const { pricing } = makePricing(live(912))
    const small = order({
      providerAmount: 912,
      details: { ...order().details!, drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 1, unitPrice: 912 }] },
    })
    await expect(pricing.priceOrder(small, 'gbp')).rejects.toMatchObject({ statusCode: 422 })
  })

  it('judges the minimum on the line totals, not the client-sent providerAmount', async () => {
    const { pricing } = makePricing(live(912))
    const lying = order({
      providerAmount: 6000,
      details: { ...order().details!, drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 1, unitPrice: 912 }] },
    })
    await expect(pricing.priceOrder(lying, 'gbp')).rejects.toBeInstanceOf(PricingError)
  })

  it('healthcareBasketShortfall says how much more NGN is needed', () => {
    expect(healthcareBasketShortfall(912)).toBe(HEALTHCARE_MIN_NGN - 912)
    expect(healthcareBasketShortfall(HEALTHCARE_MIN_NGN)).toBe(0)
    expect(healthcareBasketShortfall(9000)).toBe(0)
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
