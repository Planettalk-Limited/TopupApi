import { PricingService, PricingError } from './pricing.service'
import type { TopupFulfillmentOrder } from './payments.types'

function makeService(operators: any[]) {
  const reloadly = {
    getUrl: () => 'https://topups.reloadly.com',
    fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => operators }),
  } as any
  return new PricingService(reloadly)
}

const order: TopupFulfillmentOrder = {
  productType: 'topup', countryCode: 'GB', operatorId: 1, recipientPhone: '+447700900000',
  providerAmount: 10, providerCurrency: 'GBP', useLocalAmount: false,
}

describe('PricingService (reloadly topup)', () => {
  it('prices a valid range order = cost * 1.30', async () => {
    const svc = makeService([{ operatorId: 1, senderCurrencyCode: 'GBP', minAmount: 5, maxAmount: 50 }])
    // useLocalAmount false => ourCost = providerAmount (10 GBP); *1.30 = 13.00
    await expect(svc.priceOrder(order, 'GBP')).resolves.toBeCloseTo(13.0, 2)
  })
  it('rejects an amount outside operator limits', async () => {
    const svc = makeService([{ operatorId: 1, senderCurrencyCode: 'GBP', minAmount: 5, maxAmount: 8 }])
    await expect(svc.priceOrder(order, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })
  it('rejects an unknown operator', async () => {
    const svc = makeService([{ operatorId: 999 }])
    await expect(svc.priceOrder(order, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })
})
