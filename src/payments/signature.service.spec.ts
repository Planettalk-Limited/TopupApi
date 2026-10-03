import { SignatureService } from './signature.service'
import { buildFulfillmentMetadata } from './order-metadata'
import type { HealthcareDetails, HealthcareFulfillmentOrder, TopupFulfillmentOrder } from './payments.types'

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

describe('SignatureService — healthcare', () => {
  const svc = new SignatureService()
  beforeAll(() => { process.env.FULFILLMENT_SIGNING_SECRET = 'test-secret' })

  const details: HealthcareDetails = {
    pharmacyCode: 'WHP10431Test', isDelivery: true, buyerPhone: '+447700900000',
    patient: { firstName: 'Ada', lastName: 'Obi', gender: 'Female', phone: '08012345678', address: 'Ikeja' },
    drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, unitPrice: 912 }],
  }
  const minted: HealthcareFulfillmentOrder = {
    productType: 'healthcare', countryCode: 'NG', productId: 1951,
    providerAmount: 1824, providerCurrency: 'NGN', details,
  }

  it('verifies the hydrated order at fulfilment against the signature minted at checkout', () => {
    const sig = svc.sign(minted, '1.50', 'GBP')
    const parsedThenHydrated = {
      ...minted,
      detailsHash: buildFulfillmentMetadata(minted).detailsHash,
      details: JSON.parse(JSON.stringify(details)),
    }
    expect(svc.verify(parsedThenHydrated, '1.50', 'GBP', sig)).toBe(true)
  })

  it('rejects when the details were changed after signing', () => {
    const sig = svc.sign(minted, '1.50', 'GBP')
    const tampered = { ...minted, details: { ...details, drugs: [{ ...details.drugs[0], quantity: 9 }] } }
    expect(svc.verify(tampered, '1.50', 'GBP', sig)).toBe(false)
  })
})
