import { SignatureService } from './signature.service'
import { buildFulfillmentMetadata } from './order-metadata'
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
  it('binds productId: swapping it for a sibling product invalidates the signature', () => {
    const data = { ...order, productType: 'data' as const }
    const sig = svc.sign({ ...data, productId: 1213 }, '0.15', 'GBP')
    expect(svc.verify({ ...data, productId: 1213 }, '0.15', 'GBP', sig)).toBe(true)
    expect(svc.verify({ ...data, productId: 1285 }, '0.15', 'GBP', sig)).toBe(false)
  })
  it('signs an order without productId exactly as before (in-flight intents keep verifying)', () => {
    expect(svc.sign(order, '0.15', 'GBP')).toBe(svc.sign({ ...order, productId: undefined }, '0.15', 'GBP'))
  })
  it('carries productId in Stripe metadata only when present', () => {
    expect(buildFulfillmentMetadata({ ...order, productType: 'data', productId: 1213 }).productId).toBe('1213')
    expect(buildFulfillmentMetadata(order).productId).toBeUndefined()
  })
})
