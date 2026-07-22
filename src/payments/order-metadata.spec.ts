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
  it('build → parse round-trips the core fields', () => {
    const meta = buildFulfillmentMetadata(order)
    const parsed = parseFulfillmentOrder(meta) as TopupFulfillmentOrder
    expect(parsed.productType).toBe('topup')
    expect(parsed.operatorId).toBe(123)
    expect(parsed.recipientPhone).toBe('08055512345')
    expect(parsed.providerAmount).toBe(200)
  })
})
