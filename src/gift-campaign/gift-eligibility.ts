// Pure eligibility rules for issuing a campaign link after a fulfilled order.
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { convertCurrency } from '../payments/static-fx'
import type { GiftCampaignConfig } from './gift-campaign.config'

/** paymentIntentId prefix of the (unpaid) voucher orders this campaign creates itself. */
export const GIFT_VOUCHER_ORDER_PREFIX = 'giftcampaign_'

export interface EligibilityOrder {
  status: string
  refunded: boolean
  disputed: boolean
  customerId: string | null
  productType: string
  countryCode: string
  chargeAmount: number | { toString(): string }
  chargeCurrency: string
  paymentIntentId: string
  createdAt: Date
}

export type IneligibleReason =
  | 'CAMPAIGN_DISABLED'
  | 'NOT_STARTED'
  | 'ENDED'
  | 'GUEST_ORDER'
  | 'NOT_FULFILLED'
  | 'REFUNDED_OR_DISPUTED'
  | 'CAMPAIGN_ORDER'
  | 'PRODUCT_TYPE'
  | 'DESTINATION'
  | 'BELOW_MINIMUM'
  | 'SENDER_MARKET'

export type EligibilityResult = { eligible: true } | { eligible: false; reason: IneligibleReason }

/** ISO-2 country of an E.164 phone, or null. */
export function phoneCountry(phone: string | null | undefined): string | null {
  if (!phone) return null
  return parsePhoneNumberFromString(phone)?.country ?? null
}

/**
 * Whether a fulfilled order earns a campaign link. Only a SUCCESSFUL, settled order by a
 * signed-in customer qualifies: never a pending, failed, refunded, disputed or guest one.
 * The per-customer limit needs the DB and is enforced by the caller.
 */
export function evaluateOrderEligibility(
  order: EligibilityOrder,
  customerPhone: string | null,
  config: GiftCampaignConfig,
): EligibilityResult {
  const no = (reason: IneligibleReason): EligibilityResult => ({ eligible: false, reason })

  if (!config.enabled) return no('CAMPAIGN_DISABLED')
  if (config.startsAt && order.createdAt < config.startsAt) return no('NOT_STARTED')
  if (config.endsAt && order.createdAt > config.endsAt) return no('ENDED')
  if (!order.customerId) return no('GUEST_ORDER')
  if (order.status !== 'FULFILLED') return no('NOT_FULFILLED')
  if (order.refunded || order.disputed) return no('REFUNDED_OR_DISPUTED')
  if (order.paymentIntentId.startsWith(GIFT_VOUCHER_ORDER_PREFIX)) return no('CAMPAIGN_ORDER')
  if (!config.productTypes.includes(order.productType.toLowerCase())) return no('PRODUCT_TYPE')
  if (config.destinationCountries.length && !config.destinationCountries.includes(order.countryCode.toUpperCase())) {
    return no('DESTINATION')
  }

  const paid = Number(order.chargeAmount.toString())
  const paidGbp = convertCurrency(paid, order.chargeCurrency.toUpperCase(), 'GBP')
  if (!Number.isFinite(paidGbp) || paidGbp + 1e-6 < config.minTopupGbp) return no('BELOW_MINIMUM')

  if (config.senderCountries.length) {
    const market = phoneCountry(customerPhone)
    if (!market || !config.senderCountries.includes(market)) return no('SENDER_MARKET')
  }
  return { eligible: true }
}

/** Per-customer cap: existing non-cancelled links for this campaign vs the configured maximum. */
export function underCustomerLimit(existingLinks: number, config: GiftCampaignConfig): boolean {
  return existingLinks < config.maxPerCustomer
}
