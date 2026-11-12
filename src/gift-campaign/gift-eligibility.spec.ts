import { linkExpiry, readGiftCampaignConfig } from './gift-campaign.config'
import { evaluateOrderEligibility, GIFT_VOUCHER_ORDER_PREFIX, phoneCountry, underCustomerLimit, type EligibilityOrder } from './gift-eligibility'

const config = (env: Record<string, string> = {}) => readGiftCampaignConfig({ GIFT_CAMPAIGN_ENABLED: 'true', ...env })

const order = (over: Partial<EligibilityOrder> = {}): EligibilityOrder => ({
  status: 'FULFILLED',
  refunded: false,
  disputed: false,
  customerId: 'cust-1',
  productType: 'TOPUP',
  countryCode: 'NG',
  chargeAmount: 15,
  chargeCurrency: 'GBP',
  paymentIntentId: 'pi_123',
  createdAt: new Date('2026-11-15T12:00:00Z'),
  ...over,
})

const UK_PHONE = '+447400123456'

describe('gift campaign config', () => {
  it('is off by default, with conservative defaults', () => {
    const c = readGiftCampaignConfig({})
    expect(c.enabled).toBe(false)
    expect(c.productTypes).toEqual(['topup'])
    expect(c.maxPerCustomer).toBe(1)
    expect(c.minTopupGbp).toBe(10)
    expect(c.rewardGbp).toBe(10)
    expect(c.senderCountries).toEqual([])
    expect(Number.isInteger(c.voucherAmountNgn)).toBe(true)
    expect(c.voucherAmountNgn % 100).toBe(0)
  })

  it('parses lists, dates and numbers', () => {
    const c = config({
      GIFT_CAMPAIGN_PRODUCT_TYPES: 'TopUp, data',
      GIFT_CAMPAIGN_SENDER_COUNTRIES: 'gb,us',
      GIFT_CAMPAIGN_STARTS_AT: '2026-11-01T00:00:00Z',
      GIFT_CAMPAIGN_MAX_PER_CUSTOMER: '3',
      GIFT_CAMPAIGN_VOUCHER_AMOUNT_NGN: '20000',
    })
    expect(c.productTypes).toEqual(['topup', 'data'])
    expect(c.senderCountries).toEqual(['GB', 'US'])
    expect(c.startsAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z')
    expect(c.maxPerCustomer).toBe(3)
    expect(c.voucherAmountNgn).toBe(20000)
  })

  it('expires links at the TTL or campaign end + grace, whichever is sooner', () => {
    const issued = new Date('2026-12-01T00:00:00Z')
    expect(linkExpiry(config({ GIFT_CAMPAIGN_LINK_TTL_DAYS: '30' }), issued).toISOString()).toBe('2026-12-31T00:00:00.000Z')
    const ending = config({ GIFT_CAMPAIGN_ENDS_AT: '2026-12-05T00:00:00Z', GIFT_CAMPAIGN_SUBMISSION_GRACE_DAYS: '2' })
    expect(linkExpiry(ending, issued).toISOString()).toBe('2026-12-07T00:00:00.000Z')
  })
})

describe('evaluateOrderEligibility', () => {
  it('accepts a fulfilled top-up by a signed-in customer over the minimum', () => {
    expect(evaluateOrderEligibility(order(), UK_PHONE, config())).toEqual({ eligible: true })
  })

  it.each([
    ['campaign disabled', order(), readGiftCampaignConfig({}), 'CAMPAIGN_DISABLED'],
    ['guest checkout', order({ customerId: null }), config(), 'GUEST_ORDER'],
    ['paid but not delivered', order({ status: 'PAID' }), config(), 'NOT_FULFILLED'],
    ['failed', order({ status: 'FAILED' }), config(), 'NOT_FULFILLED'],
    ['created (checkout initiated)', order({ status: 'CREATED' }), config(), 'NOT_FULFILLED'],
    ['refunded', order({ refunded: true }), config(), 'REFUNDED_OR_DISPUTED'],
    ['disputed', order({ disputed: true }), config(), 'REFUNDED_OR_DISPUTED'],
    ['a gift card', order({ productType: 'GIFTCARD' }), config(), 'PRODUCT_TYPE'],
    ['below the minimum', order({ chargeAmount: 9.99 }), config(), 'BELOW_MINIMUM'],
    ['the campaign voucher itself', order({ paymentIntentId: `${GIFT_VOUCHER_ORDER_PREFIX}x_1`, productType: 'TOPUP' }), config(), 'CAMPAIGN_ORDER'],
    ['before the start', order(), config({ GIFT_CAMPAIGN_STARTS_AT: '2026-12-01T00:00:00Z' }), 'NOT_STARTED'],
    ['after the end', order(), config({ GIFT_CAMPAIGN_ENDS_AT: '2026-11-01T00:00:00Z' }), 'ENDED'],
    ['outside destination corridors', order({ countryCode: 'GH' }), config({ GIFT_CAMPAIGN_DESTINATION_COUNTRIES: 'NG' }), 'DESTINATION'],
  ])('rejects %s', (_label, o, c, reason) => {
    expect(evaluateOrderEligibility(o, UK_PHONE, c)).toEqual({ eligible: false, reason })
  })

  it('converts non-GBP charges before comparing to the GBP minimum', () => {
    // 13 USD ~ 10.27 GBP at the static table (GBP 0.79 per USD)
    expect(evaluateOrderEligibility(order({ chargeAmount: 13, chargeCurrency: 'usd' }), UK_PHONE, config()).eligible).toBe(true)
    expect(evaluateOrderEligibility(order({ chargeAmount: 12, chargeCurrency: 'USD' }), UK_PHONE, config()).eligible).toBe(false)
  })

  it('accepts Prisma Decimal-like amounts', () => {
    expect(evaluateOrderEligibility(order({ chargeAmount: { toString: () => '10.00' } }), UK_PHONE, config()).eligible).toBe(true)
  })

  it('honours extra product types from config', () => {
    const c = config({ GIFT_CAMPAIGN_PRODUCT_TYPES: 'topup,data' })
    expect(evaluateOrderEligibility(order({ productType: 'DATA' }), UK_PHONE, c).eligible).toBe(true)
  })

  it('restricts sender markets by the account phone when configured', () => {
    const c = config({ GIFT_CAMPAIGN_SENDER_COUNTRIES: 'GB,IE' })
    expect(evaluateOrderEligibility(order(), UK_PHONE, c).eligible).toBe(true)
    expect(evaluateOrderEligibility(order(), '+12025550123', c)).toEqual({ eligible: false, reason: 'SENDER_MARKET' })
    expect(evaluateOrderEligibility(order(), null, c)).toEqual({ eligible: false, reason: 'SENDER_MARKET' })
    expect(phoneCountry(UK_PHONE)).toBe('GB')
  })

  it('enforces one reward per customer by default', () => {
    expect(underCustomerLimit(0, config())).toBe(true)
    expect(underCustomerLimit(1, config())).toBe(false)
    expect(underCustomerLimit(1, config({ GIFT_CAMPAIGN_MAX_PER_CUSTOMER: '2' }))).toBe(true)
  })
})
