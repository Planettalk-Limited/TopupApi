import {
  HealthcareIntegrityError,
  hashHealthcareDetails,
  healthcareProductName,
  healthcareProviderTotal,
  hydrateHealthcareOrder,
  validateHealthcareOrder,
} from './healthcare-order'
import type { HealthcareDetails, HealthcareFulfillmentOrder } from './payments.types'

const details: HealthcareDetails = {
  pharmacyCode: 'WHP10431Test',
  isDelivery: true,
  buyerPhone: '+447700900000',
  patient: {
    firstName: 'Ada',
    lastName: 'Obi',
    gender: 'Female',
    phone: '08012345678',
    address: '1 Allen Avenue, Ikeja, Lagos',
  },
  drugs: [
    { drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, unitPrice: 912 },
    { drugName: 'AMOXICILLIN 500MG CAPS X100', quantity: 1, unitPrice: 6270, dose: 'Cap 500mg tds 5/7' },
  ],
}

function order(overrides: Partial<HealthcareFulfillmentOrder> = {}, d: Partial<HealthcareDetails> = {}): HealthcareFulfillmentOrder {
  return {
    productType: 'healthcare',
    countryCode: 'NG',
    productId: 1951,
    providerAmount: 8094,
    providerCurrency: 'NGN',
    email: 'buyer@example.com',
    details: { ...details, ...d },
    ...overrides,
  }
}

describe('healthcare-order', () => {
  describe('hashHealthcareDetails', () => {
    it('is stable regardless of key order (Postgres JSONB reorders keys)', () => {
      const reordered = JSON.parse(
        JSON.stringify({
          drugs: details.drugs.map((l) => ({ unitPrice: l.unitPrice, quantity: l.quantity, drugName: l.drugName, dose: l.dose })),
          patient: { ...details.patient },
          buyerPhone: details.buyerPhone,
          isDelivery: true,
          pharmacyCode: details.pharmacyCode,
        }),
      )
      expect(hashHealthcareDetails(reordered)).toBe(hashHealthcareDetails(details))
    })

    it('changes when any detail changes', () => {
      const base = hashHealthcareDetails(details)
      expect(hashHealthcareDetails({ ...details, pharmacyCode: 'WHP99999Test' })).not.toBe(base)
      expect(hashHealthcareDetails({ ...details, patient: { ...details.patient, address: 'elsewhere' } })).not.toBe(base)
      expect(
        hashHealthcareDetails({ ...details, drugs: [{ ...details.drugs[0], quantity: 3 }, details.drugs[1]] }),
      ).not.toBe(base)
    })
  })

  it('totals pack price x quantity', () => {
    expect(healthcareProviderTotal(details)).toBe(912 * 2 + 6270)
  })

  it('builds a readable product name', () => {
    expect(healthcareProductName(details)).toBe(
      'Pharmacy: EMZOR PARACETAMOL SYRUP 60ML x2, AMOXICILLIN 500MG CAPS X100 x1',
    )
  })

  describe('validateHealthcareOrder', () => {
    it('accepts a complete order', () => {
      expect(validateHealthcareOrder(order())).toBeNull()
    })

    it.each([
      ['non-Nigerian order', order({ countryCode: 'GB' }), /Nigeria/],
      ['non-NGN amount', order({ providerCurrency: 'USD' }), /NGN/],
      ['missing buyer email', order({ email: undefined }), /email/],
      ['bad buyer phone', order({}, { buyerPhone: 'call me' }), /phone/],
      ['missing pharmacy', order({}, { pharmacyCode: ' ' }), /pharmacyCode/],
      ['non-Nigerian beneficiary phone', order({}, { patient: { ...details.patient, phone: '+447700900000' } }), /Nigerian/],
      ['bad gender', order({}, { patient: { ...details.patient, gender: 'male' as never } }), /gender/],
      ['missing address', order({}, { patient: { ...details.patient, address: '' } }), /address/],
      ['no drugs', order({}, { drugs: [] }), /at least one/],
      ['duplicate drug', order({ providerAmount: 1824 }, { drugs: [details.drugs[0], details.drugs[0]] }), /only once/],
      ['quantity too high', order({}, { drugs: [{ ...details.drugs[0], quantity: 11 }] }), /Quantity/],
      ['unpriced line', order({}, { drugs: [{ ...details.drugs[0], unitPrice: 0 }] }), /price/],
      ['total mismatch', order({ providerAmount: 100 }), /total/],
    ])('rejects %s', (_label, o, message) => {
      expect(validateHealthcareOrder(o)).toMatch(message)
    })
  })

  describe('hydrateHealthcareOrder', () => {
    const parsed = (): HealthcareFulfillmentOrder => ({
      ...order(),
      details: undefined,
      detailsHash: hashHealthcareDetails(details),
    })

    it('attaches details that match the hash', () => {
      expect(hydrateHealthcareOrder(parsed(), JSON.parse(JSON.stringify(details))).details).toEqual(details)
    })

    it('rejects tampered details', () => {
      const tampered = { ...details, pharmacyCode: 'WHP99999Test' }
      expect(() => hydrateHealthcareOrder(parsed(), tampered)).toThrow(HealthcareIntegrityError)
    })

    it('rejects missing details or a missing hash', () => {
      expect(() => hydrateHealthcareOrder(parsed(), null)).toThrow(HealthcareIntegrityError)
      expect(() => hydrateHealthcareOrder({ ...parsed(), detailsHash: undefined }, details)).toThrow(
        HealthcareIntegrityError,
      )
    })
  })
})
