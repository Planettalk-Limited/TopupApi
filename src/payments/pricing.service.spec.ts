import { PricingService, PricingError } from './pricing.service'
import type { GiftCardFulfillmentOrder, TopupFulfillmentOrder, UtilityFulfillmentOrder } from './payments.types'

function makeService(products: any[], planetTalkOverrides: any = {}) {
  const reloadly = {
    getUrl: () => 'https://topups.reloadly.com',
    fetch: jest.fn().mockResolvedValue({ ok: true, json: async () => products }),
  } as any
  const planetTalk = {
    fetchAndBuildOperators: jest.fn().mockResolvedValue({ operators: [], productMap: {} }),
    fetchAndBuildBillers: jest.fn().mockResolvedValue([]),
    ...planetTalkOverrides,
  } as any
  return new PricingService(reloadly, planetTalk)
}

function makePlanetTalkService(build: { operators?: any[]; billers?: any[] } = {}) {
  const planetTalk = {
    fetchAndBuildOperators: jest.fn().mockResolvedValue({ operators: build.operators ?? [], productMap: {} }),
    fetchAndBuildBillers: jest.fn().mockResolvedValue(build.billers ?? []),
  } as any
  const reloadly = { getUrl: jest.fn(), fetch: jest.fn() } as any
  return new PricingService(reloadly, planetTalk)
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

})

// ---------------------------------------------------------------------------
// PlanetTalk (buhibab) topup/data + utility pricing — with the global-limits
// exemption for PlanetTalk top-ups (see pricing.service.ts `priceOrder`).
// ---------------------------------------------------------------------------
const ngTopupOrder: TopupFulfillmentOrder = {
  productType: 'topup',
  countryCode: 'NG',
  operatorId: 100,
  recipientPhone: '08012345678',
  providerAmount: 200, // NGN 200 ≈ £0.10 — deliberately below the global £3–£20 band
  providerCurrency: 'NGN',
  useLocalAmount: true,
}

// Below the global £3–£20 band (NGN 500 ≈ £0.25) — used to prove utilities do NOT get
// the PlanetTalk top-up exemption.
const ngUtilityOrderBelowBand: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'NG',
  billerId: 42,
  accountNumber: '1234567890',
  providerAmount: 500,
  providerCurrency: 'NGN',
}

// Within the global £3–£20 band (NGN 20,000 ≈ £10.19) — used for the pricing-model
// assertions, which must be isolated from the (separately-tested) global-band gate.
const ngUtilityOrder: UtilityFulfillmentOrder = {
  ...ngUtilityOrderBelowBand,
  providerAmount: 20000,
}

describe('PricingService (planettalk topup — global-limits exemption)', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.TOPUP_PROVIDER_NG
    process.env.TOPUP_PROVIDER_NG = 'planettalk'
  })

  afterEach(() => {
    process.env.TOPUP_PROVIDER_NG = originalEnv
  })

  it('prices a sub-£1 NG top-up WITHOUT being rejected by the global £3–£20 band (the exemption)', async () => {
    const svc = makePlanetTalkService({
      operators: [{ operatorId: 100, senderCurrencyCode: 'USD', fx: { rate: 1550 }, localFixedAmounts: [200] }],
    })
    // ourCost = 200/1550 USD ≈ 0.12903 USD; * 1.30 ≈ 0.16774 USD ≈ £0.1325 (well under £3)
    const charged = await svc.priceOrder(ngTopupOrder, 'GBP')
    expect(charged).toBeGreaterThan(0)
    expect(charged).toBeLessThan(1) // proves assertWithinGlobalLimits was skipped
  })

  it('computes the correct charge = (localAmount/fx.rate) * 1.30, converted to the charge currency', async () => {
    const svc = makePlanetTalkService({
      operators: [{ operatorId: 100, senderCurrencyCode: 'USD', fx: { rate: 1550 }, localFixedAmounts: [200] }],
    })
    // ourCost = 200/1550 = 0.129032... USD; charge USD = 0.129032 * 1.30 = 0.167742 -> convertCurrency(USD->USD) = 0.17 (rounded to 2dp)
    await expect(svc.priceOrder(ngTopupOrder, 'USD')).resolves.toBeCloseTo(0.17, 2)
  })

  it('a NON-PlanetTalk (Reloadly) NG top-up at the same sub-£1 amount is still rejected by the global band', async () => {
    process.env.TOPUP_PROVIDER_NG = originalEnv // resolves to reloadly for this order
    const svc = makeService([{ operatorId: 100, senderCurrencyCode: 'GBP', localFixedAmounts: [200] }])
    await expect(svc.priceOrder(ngTopupOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects an amount not offered by the PlanetTalk operator', async () => {
    const svc = makePlanetTalkService({
      operators: [{ operatorId: 100, senderCurrencyCode: 'USD', fx: { rate: 1550 }, localFixedAmounts: [500] }],
    })
    await expect(svc.priceOrder(ngTopupOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects an unknown PlanetTalk operator', async () => {
    const svc = makePlanetTalkService({ operators: [{ operatorId: 999 }] })
    await expect(svc.priceOrder(ngTopupOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })
})

describe('PricingService (planettalk utility pay-bill)', () => {
  let originalEnv: string | undefined

  beforeEach(() => {
    originalEnv = process.env.TOPUP_PROVIDER_NG
    process.env.TOPUP_PROVIDER_NG = 'planettalk'
  })

  afterEach(() => {
    process.env.TOPUP_PROVIDER_NG = originalEnv
  })

  it('prices via biller.fx.rate in the biller sender currency (USD, not GBP): (amount/fx.rate) * 1.30', async () => {
    const svc = makePlanetTalkService({
      billers: [
        {
          id: 42,
          senderCurrencyCode: 'USD',
          fx: { rate: 1550 },
          minLocalTransactionAmount: 100,
          maxLocalTransactionAmount: 100000,
        },
      ],
    })
    // ourCost = 20000/1550 USD ≈ 12.90323 USD; * 1.30 ≈ 16.77419 USD
    await expect(svc.priceOrder(ngUtilityOrder, 'USD')).resolves.toBeCloseTo(16.77, 2)
  })

  it('is still subject to the global £3–£20 band (only PlanetTalk TOPUPS are exempt, not utilities)', async () => {
    const svc = makePlanetTalkService({
      billers: [
        {
          id: 42,
          senderCurrencyCode: 'USD',
          fx: { rate: 1550 },
          minLocalTransactionAmount: 100,
          maxLocalTransactionAmount: 100000,
        },
      ],
    })
    // NGN 500 is a tiny face value, well below the £3 band -> rejected before pricePlanetTalkUtility runs.
    await expect(svc.priceOrder(ngUtilityOrderBelowBand, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects an amount outside the biller local min/max bounds', async () => {
    const svc = makePlanetTalkService({
      billers: [
        {
          id: 42,
          senderCurrencyCode: 'USD',
          fx: { rate: 1550 },
          minLocalTransactionAmount: 100000,
          maxLocalTransactionAmount: 200000,
        },
      ],
    })
    await expect(svc.priceOrder(ngUtilityOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })

  it('rejects an unknown PlanetTalk biller', async () => {
    const svc = makePlanetTalkService({ billers: [{ id: 999 }] })
    await expect(svc.priceOrder(ngUtilityOrder, 'GBP')).rejects.toBeInstanceOf(PricingError)
  })
})
