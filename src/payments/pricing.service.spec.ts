import { PricingService, PricingError } from './pricing.service'
import type { GiftCardFulfillmentOrder, TopupFulfillmentOrder, UtilityFulfillmentOrder } from './payments.types'

function makeService(products: any[]) {
  const reloadly = {
    getUrl: () => 'https://topups.reloadly.com',
    fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => products }),
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

const giftCardOrder: GiftCardFulfillmentOrder = {
  productType: 'giftcard',
  countryCode: 'GB',
  productId: 42,
  providerAmount: 20,
  providerCurrency: 'GBP',
}

describe('PricingService (reloadly gift card)', () => {
  it('prices a FIXED-denomination product via the recipient->sender map, then * 1.30', async () => {
    const svc = makeService([
      {
        productId: 42,
        denominationType: 'FIXED',
        senderCurrencyCode: 'GBP',
        fixedRecipientDenominations: [10, 20, 50],
        // Reloadly keys this map by stringified floats — sender base for a £20 card is £18.
        fixedRecipientToSenderDenominationsMap: { '10.0': 9, '20.0': 18, '50.0': 45 },
        senderFee: 0,
        senderFeePercentage: 0,
      },
    ])
    // senderBase = 18 (GBP) + no fees; ourCost = 18; * 1.30 = 23.40
    await expect(svc.priceOrder(giftCardOrder, 'GBP')).resolves.toBeCloseTo(23.4, 2)
  })

  it('applies senderFee + senderFeePercentage on top of the sender base before markup', async () => {
    const svc = makeService([
      {
        productId: 42,
        denominationType: 'FIXED',
        senderCurrencyCode: 'GBP',
        fixedRecipientDenominations: [20],
        fixedRecipientToSenderDenominationsMap: { '20.0': 18 },
        senderFee: 1,
        senderFeePercentage: 10,
      },
    ])
    // senderBase = 18; ourCost = 18 + 1 + 18*0.10 = 20.80; * 1.30 = 27.04
    await expect(svc.priceOrder(giftCardOrder, 'GBP')).resolves.toBeCloseTo(27.04, 2)
  })

  it('rejects a recipient amount not offered by a FIXED-denomination product', async () => {
    const svc = makeService([
      {
        productId: 42,
        denominationType: 'FIXED',
        senderCurrencyCode: 'GBP',
        fixedRecipientDenominations: [10, 50],
        fixedRecipientToSenderDenominationsMap: { '10.0': 9, '50.0': 45 },
      },
    ])
    await expect(svc.priceOrder(giftCardOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('prices a RANGE product by linear interpolation between recipient/sender bounds', async () => {
    const svc = makeService([
      {
        productId: 42,
        denominationType: 'RANGE',
        senderCurrencyCode: 'GBP',
        minRecipientDenomination: 10,
        maxRecipientDenomination: 30,
        minSenderDenomination: 9,
        maxSenderDenomination: 27,
        senderFee: 0,
        senderFeePercentage: 0,
      },
    ])
    // recipientAmount=20 -> ratio 0.5 -> senderBase = 9 + 0.5*(27-9) = 18; * 1.30 = 23.40
    await expect(svc.priceOrder(giftCardOrder, 'GBP')).resolves.toBeCloseTo(23.4, 2)
  })

  it('rejects an unknown gift-card product', async () => {
    const svc = makeService([{ productId: 999 }])
    await expect(svc.priceOrder(giftCardOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })
})

const utilityOrder: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'GB',
  billerId: 7,
  accountNumber: '04223568280',
  providerAmount: 10,
  providerCurrency: 'GBP',
}

describe('PricingService (reloadly utility pay-bill)', () => {
  it('prices via biller.fx.rate: (amount/fx.rate + fee/fx.rate) * 1.30', async () => {
    const svc = makeService([
      { id: 7, minLocalTransactionAmount: 1, maxLocalTransactionAmount: 100, fx: { rate: 2 }, localTransactionFee: 1 },
    ])
    // ourCost = 10/2 + 1/2 = 5.5 GBP; * 1.30 = 7.15
    await expect(svc.priceOrder(utilityOrder, 'GBP')).resolves.toBeCloseTo(7.15, 2)
  })

  it('falls back to convertCurrency(amount, providerCurrency, GBP) when the biller has no fx.rate, adding the fee in its own currency', async () => {
    const svc = makeService([
      {
        id: 7,
        minLocalTransactionAmount: 1,
        maxLocalTransactionAmount: 100,
        localTransactionFee: 1,
        localTransactionFeeCurrencyCode: 'GBP',
      },
    ])
    // no fx.rate: ourCost = convertCurrency(10, GBP, GBP) + convertCurrency(1, GBP, GBP) = 11; * 1.30 = 14.30
    await expect(svc.priceOrder(utilityOrder, 'GBP')).resolves.toBeCloseTo(14.3, 2)
  })

  it('applies no fee term when localTransactionFee is 0/absent', async () => {
    const svc = makeService([{ id: 7, minLocalTransactionAmount: 1, maxLocalTransactionAmount: 100, fx: { rate: 2 } }])
    // ourCost = 10/2 = 5 GBP; * 1.30 = 6.50
    await expect(svc.priceOrder(utilityOrder, 'GBP')).resolves.toBeCloseTo(6.5, 2)
  })

  it('rejects an amount outside the biller local min/max bounds', async () => {
    const svc = makeService([{ id: 7, minLocalTransactionAmount: 50, maxLocalTransactionAmount: 100, fx: { rate: 2 } }])
    await expect(svc.priceOrder(utilityOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects an unknown biller', async () => {
    const svc = makeService([{ id: 999 }])
    await expect(svc.priceOrder(utilityOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects a utility order that resolves to the PlanetTalk provider with a 501 (not yet implemented)', async () => {
    const svc = makeService([{ id: 7 }])
    const originalEnv = process.env.TOPUP_PROVIDER_NG
    process.env.TOPUP_PROVIDER_NG = 'planettalk'
    try {
      await expect(
        svc.priceOrder({ ...utilityOrder, countryCode: 'NG' }, 'GBP')
      ).rejects.toMatchObject({ statusCode: 501 })
    } finally {
      process.env.TOPUP_PROVIDER_NG = originalEnv
    }
  })
})
