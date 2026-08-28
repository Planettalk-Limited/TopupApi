import { buildFulfillmentMetadata, parseFulfillmentOrder, validateFulfillmentOrder } from './order-metadata'
import type { TopupFulfillmentOrder } from './payments.types'

const order: TopupFulfillmentOrder = {
  productType: 'topup', countryCode: 'NG', operatorId: 123, recipientPhone: '08055512345',
  providerAmount: 200, providerCurrency: 'NGN', useLocalAmount: true, email: 'a@b.com',
}

describe('order-metadata', () => {
  it('validates a good topup order', () => {
    expect(validateFulfillmentOrder(order)).toBeNull()
  })
  it('rejects a topup missing operatorId', () => {
    expect(validateFulfillmentOrder({ ...order, operatorId: undefined as any })).toMatch(/operatorId/)
  })

  // Pre-charge gate. Without this the only phone check happened inside the provider
  // executor, i.e. after Stripe had already taken the money — an unusable number became a
  // charged-but-unfulfillable order needing a manual refund. Reject it at create-intent
  // instead, while the customer can still correct it.
  describe('recipientPhone validation (runs before the customer is charged)', () => {
    it('accepts a valid number in national or international form', () => {
      expect(validateFulfillmentOrder({ ...order, recipientPhone: '08055512345' })).toBeNull()
      expect(validateFulfillmentOrder({ ...order, recipientPhone: '+2348055512345' })).toBeNull()
    })

    it('rejects a number that is not valid for the order country', () => {
      expect(validateFulfillmentOrder({ ...order, recipientPhone: '12345' })).toMatch(/recipientPhone/)
      expect(validateFulfillmentOrder({ ...order, recipientPhone: 'not a phone' })).toMatch(/recipientPhone/)
    })

    it('rejects a GB number submitted against the wrong country', () => {
      expect(validateFulfillmentOrder({ ...order, countryCode: 'GB', recipientPhone: '08055512345' })).toMatch(/recipientPhone/)
    })

    it('applies to data orders too, not just topup', () => {
      expect(validateFulfillmentOrder({ ...order, productType: 'data', recipientPhone: '12345' })).toMatch(/recipientPhone/)
    })

    it('does not require a phone on giftcard or utility orders', () => {
      expect(validateFulfillmentOrder({ productType: 'giftcard', countryCode: 'NG', providerAmount: 10, providerCurrency: 'NGN', productId: 7 } as any)).toBeNull()
    })

    it('still reports the missing-phone case before the validity case', () => {
      expect(validateFulfillmentOrder({ ...order, recipientPhone: '   ' })).toMatch(/required/)
    })
  })

  it('build → parse round-trips the core fields', () => {
    const meta = buildFulfillmentMetadata(order)
    const parsed = parseFulfillmentOrder(meta) as TopupFulfillmentOrder
    expect(parsed.productType).toBe('topup')
    expect(parsed.operatorId).toBe(123)
    expect(parsed.recipientPhone).toBe('08055512345')
    expect(parsed.providerAmount).toBe(200)
  })
})
