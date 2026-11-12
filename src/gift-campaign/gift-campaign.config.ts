// Configuration for the "Gift a Loved One in Nigeria" campaign.
//
// Everything that the requirements brief leaves open (dates, minimum top-up, sender
// markets, limits, voucher brand/denomination) is an env var with a conservative default,
// so the campaign can be tuned without a deploy of new code. The campaign is OFF unless
// GIFT_CAMPAIGN_ENABLED=true.
import { convertCurrency } from '../payments/static-fx'

export interface GiftCampaignConfig {
  enabled: boolean
  /** Stored on every row, so a later re-run of the campaign keeps its own limits. */
  campaignKey: string
  startsAt: Date | null
  endsAt: Date | null
  /** Minimum the customer actually paid for the qualifying order, in GBP. */
  minTopupGbp: number
  /** Lower-case product types that qualify (topup, data, giftcard, utility, healthcare, voucher). */
  productTypes: string[]
  /** ISO-2 sender markets, from the account phone's country. Empty = any. */
  senderCountries: string[]
  /** ISO-2 destination countries of the qualifying order (order.countryCode). Empty = any. */
  destinationCountries: string[]
  /** Entitlements (links) per customer for this campaign. Default 1 = one reward per customer. */
  maxPerCustomer: number
  /** A link expires this many days after it is issued... */
  linkTtlDays: number
  /** ...or this many days after the campaign ends, whichever is sooner. */
  submissionGraceDays: number
  termsVersion: string
  termsUrl: string | null
  privacyUrl: string | null
  rewardGbp: number
  /** buhibab (SureGifts) voucher product the reward is issued as. */
  voucherProductId: number | null
  /** Face value in whole naira. Defaults to rewardGbp converted at the static FX table. */
  voucherAmountNgn: number
  /** buhibab requires an email on every purchase; used when the recipient gave none. */
  fulfilmentEmail: string | null
  /** Locale segment used in emailed links. */
  linkLocale: string
  supportEmail: string
}

const csv = (v: string | undefined, transform: (s: string) => string) =>
  (v ?? '')
    .split(',')
    .map((s) => transform(s.trim()))
    .filter(Boolean)

const date = (v: string | undefined): Date | null => {
  if (!v?.trim()) return null
  const d = new Date(v.trim())
  return Number.isNaN(d.getTime()) ? null : d
}

const num = (v: string | undefined, fallback: number): number => {
  if (v === undefined || v.trim() === '') return fallback
  const n = Number(v)
  return Number.isFinite(n) ? n : fallback
}

/** Pure: reads the campaign config from an env map (process.env in the app, a literal in tests). */
export function readGiftCampaignConfig(env: Record<string, string | undefined> = process.env): GiftCampaignConfig {
  const rewardGbp = num(env.GIFT_CAMPAIGN_REWARD_GBP, 10)
  const productId = num(env.GIFT_CAMPAIGN_VOUCHER_PRODUCT_ID, NaN)
  // buhibab takes whole naira; round to the nearest 100 so the face value reads cleanly.
  const defaultNgn = Math.round(convertCurrency(rewardGbp, 'GBP', 'NGN') / 100) * 100
  const fulfilmentEmail = env.GIFT_CAMPAIGN_FULFILMENT_EMAIL?.trim() || null
  return {
    enabled: env.GIFT_CAMPAIGN_ENABLED === 'true',
    campaignKey: env.GIFT_CAMPAIGN_KEY?.trim() || 'gift-nigeria-2026',
    startsAt: date(env.GIFT_CAMPAIGN_STARTS_AT),
    endsAt: date(env.GIFT_CAMPAIGN_ENDS_AT),
    minTopupGbp: num(env.GIFT_CAMPAIGN_MIN_TOPUP_GBP, 10),
    productTypes: (() => {
      const list = csv(env.GIFT_CAMPAIGN_PRODUCT_TYPES, (s) => s.toLowerCase())
      return list.length ? list : ['topup']
    })(),
    senderCountries: csv(env.GIFT_CAMPAIGN_SENDER_COUNTRIES, (s) => s.toUpperCase()),
    destinationCountries: csv(env.GIFT_CAMPAIGN_DESTINATION_COUNTRIES, (s) => s.toUpperCase()),
    maxPerCustomer: Math.max(1, Math.floor(num(env.GIFT_CAMPAIGN_MAX_PER_CUSTOMER, 1))),
    linkTtlDays: Math.max(1, num(env.GIFT_CAMPAIGN_LINK_TTL_DAYS, 30)),
    submissionGraceDays: Math.max(0, num(env.GIFT_CAMPAIGN_SUBMISSION_GRACE_DAYS, 7)),
    termsVersion: env.GIFT_CAMPAIGN_TERMS_VERSION?.trim() || 'draft-2026-11',
    termsUrl: env.GIFT_CAMPAIGN_TERMS_URL?.trim() || null,
    privacyUrl: env.GIFT_CAMPAIGN_PRIVACY_URL?.trim() || null,
    rewardGbp,
    voucherProductId: Number.isInteger(productId) && productId > 0 ? productId : null,
    voucherAmountNgn: Math.round(num(env.GIFT_CAMPAIGN_VOUCHER_AMOUNT_NGN, defaultNgn)),
    fulfilmentEmail,
    linkLocale: env.GIFT_CAMPAIGN_LINK_LOCALE?.trim() || 'en',
    supportEmail: 'care@planettalk.com',
  }
}

/** When a link issued at `issuedAt` stops working. */
export function linkExpiry(config: GiftCampaignConfig, issuedAt: Date): Date {
  const ttl = new Date(issuedAt.getTime() + config.linkTtlDays * 86_400_000)
  if (!config.endsAt) return ttl
  const campaignClose = new Date(config.endsAt.getTime() + config.submissionGraceDays * 86_400_000)
  return ttl < campaignClose ? ttl : campaignClose
}
