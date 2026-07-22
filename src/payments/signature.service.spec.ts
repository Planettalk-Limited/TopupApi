import { SignatureService } from './signature.service'
import type { TopupFulfillmentOrder } from './payments.types'

const order: TopupFulfillmentOrder = {
  productType: 'topup', countryCode: 'ng', operatorId: 123, recipientPhone: '08055512345',
  providerAmount: 200, providerCurrency: 'ngn', useLocalAmount: true,
}

describe('SignatureService', () => {
  const svc = new SignatureService()
  beforeAll(() => { process.env.FULFILLMENT_SIGNING_SECRET = 'test-secret' })

  it('round-trips a valid signature', () => {
    const sig = svc.sign(order, '0.15', 'GBP')
    expect(svc.verify(order, '0.15', 'GBP', sig)).toBe(true)
  })
  it('rejects a tampered charge amount', () => {
    const sig = svc.sign(order, '0.15', 'GBP')
    expect(svc.verify(order, '9.99', 'GBP', sig)).toBe(false)
  })
  it('rejects a missing signature', () => {
    expect(svc.verify(order, '0.15', 'GBP', undefined)).toBe(false)
  })
})
