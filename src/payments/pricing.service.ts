// Ported verbatim (Reloadly mobile-topup + gift-card + utility pay-bill paths) from
// TopupApp/src/lib/fulfillment/pricing.ts, wrapped as a NestJS Injectable service.
//
// SECURITY: This module is the single source of truth for how much a customer is
// charged for a given fulfillment order. The Stripe charge MUST be derived here from
// the order plus the provider's own product data — never from a client-supplied
// "amount". This binds the price paid to the value delivered and closes the
// parameter-tampering hole where a cheap charge could be forged for an expensive order.
//
// The charge is computed as `ourCost * MARKUP`, mirroring the exact cost model the
// client UI uses, and converted with the same `convertCurrency` helper so the amount
// charged matches the amount displayed. Cost models:
//   - topup/data : (useLocalAmount ? localAmount / operator.fx.rate : amount) in sender currency
//   - giftcard   : sender denomination (from the product's recipient→sender map / range) + sender fees
//   - utility    : (amount / biller.fx.rate) + biller fee, in wallet currency (GBP)
//
// Adaptations from the frontend source (see task brief): `convertCurrency` /
// `getStripeLimits` come from `./static-fx` (not the frontend's currency/stripe-limits
// libs), order types come from `./payments.types`, and Reloadly operators/products/billers
// are fetched via the injected `ReloadlyService` instead of `fetchWithTokenRefresh`.
// PlanetTalk pricing (topup/utility) is out of scope for this SP-2 slice and remains
// stubbed to a 501 PricingError for any order that resolves to that provider; it arrives
// with the PlanetTalk utility executor.

import { Injectable } from '@nestjs/common'
import { ReloadlyService } from '../providers/reloadly/reloadly.service'
import { resolveProvider } from './order-metadata'
import { convertCurrency, getStripeLimits } from './static-fx'
import type {
  FulfillmentOrder,
  GiftCardFulfillmentOrder,
  TopupFulfillmentOrder,
  UtilityFulfillmentOrder,
} from './payments.types'

/** Markup applied on top of provider cost. Mirrors the client-side `* 1.30`. */
export const MARKUP = 1.3

/** Global per-transaction business limits in GBP (see global-limits.ts). */
export const GLOBAL_MIN_GBP = 3
export const GLOBAL_MAX_GBP = 20

/**
 * Tolerance to absorb FX/rounding drift between the rate used to build the order and
 * the rate used to validate it. The cap is the security-relevant bound, so a few
 * percent of slack here does not meaningfully change exposure.
 */
const LIMIT_TOLERANCE = 0.1

export class PricingError extends Error {
  statusCode: number
  constructor(message: string, statusCode = 400) {
    super(message)
    this.name = 'PricingError'
    this.statusCode = statusCode
  }
}

function roundToCurrencyDecimals(amount: number, currency: string): number {
  const { decimals } = getStripeLimits(currency)
  const factor = Math.pow(10, decimals)
  return Math.round(amount * factor) / factor
}

function toNumberList(value: unknown): number[] {
  if (Array.isArray(value)) return value.map(Number).filter((n) => Number.isFinite(n))
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .map(Number)
      .filter((n) => Number.isFinite(n))
  }
  return []
}

// ---------------------------------------------------------------------------
// Reloadly mobile top-ups / data
// ---------------------------------------------------------------------------
function assertTopupDenomination(order: TopupFulfillmentOrder, operator: any): void {
  const useLocal = order.useLocalAmount ?? true
  const fixed = useLocal ? operator.localFixedAmounts : operator.fixedAmounts
  const min = useLocal ? operator.localMinAmount : operator.minAmount
  const max = useLocal ? operator.localMaxAmount : operator.maxAmount
  const requested = order.providerAmount

  const fixedList = toNumberList(fixed)
  if (fixedList.length > 0) {
    if (!fixedList.some((v) => Math.abs(v - requested) < 0.01)) {
      throw new PricingError('Requested amount is not offered by this operator', 400)
    }
    return
  }

  if (typeof min === 'number' && typeof max === 'number' && max > 0) {
    if (requested < min - 1e-6 || requested > max + 1e-6) {
      throw new PricingError('Requested amount is outside the operator limits', 400)
    }
  }
}

/**
 * Validate the requested amount against an operator's real denominations/limits and compute
 * the authoritative charge. Shared by the Reloadly and PlanetTalk top-up paths so both bind
 * the charge to live provider data the same way and produce the same number the client UI
 * displays (`order.providerAmount / operator.fx.rate` in sender currency, then markup).
 */
function priceTopupForOperator(
  order: TopupFulfillmentOrder,
  operator: any,
  chargeCurrency: string
): number {
  assertTopupDenomination(order, operator)

  const useLocal = order.useLocalAmount ?? true
  const ourCost =
    useLocal && operator.fx?.rate ? order.providerAmount / operator.fx.rate : order.providerAmount
  const senderCurrency = operator.senderCurrencyCode || 'GBP'

  return roundToCurrencyDecimals(
    convertCurrency(ourCost * MARKUP, senderCurrency, chargeCurrency),
    chargeCurrency
  )
}

/**
 * Reject orders whose face value (in GBP) falls outside the global business limits.
 * The upper bound is the key anti-fraud control (caps exposure per transaction).
 */
export function assertWithinGlobalLimits(order: FulfillmentOrder): void {
  const gbp = convertCurrency(order.providerAmount, order.providerCurrency, 'GBP')

  if (!Number.isFinite(gbp) || gbp <= 0) {
    throw new PricingError('Invalid order amount')
  }

  const min = GLOBAL_MIN_GBP * (1 - LIMIT_TOLERANCE)
  const max = GLOBAL_MAX_GBP * (1 + LIMIT_TOLERANCE)
  if (gbp < min || gbp > max) {
    throw new PricingError(`Amount must be between £${GLOBAL_MIN_GBP} and £${GLOBAL_MAX_GBP}`)
  }
}

@Injectable()
export class PricingService {
  constructor(private readonly reloadly: ReloadlyService) {}

  /** Fetch Reloadly topup operators for a country (mirrors the frontend's fetchReloadlyList). */
  private async fetchReloadlyOperators(countryCode: string): Promise<any[]> {
    const res = await this.reloadly.fetch(
      'topups',
      `${this.reloadly.getUrl('topups')}/operators/countries/${countryCode}`,
      { headers: { Accept: 'application/com.reloadly.topups-v1+json' } }
    )

    if (!res.ok) {
      throw new PricingError('Unable to validate this order with the provider', 400)
    }

    const data = await res.json()
    return Array.isArray(data) ? data : data.content || []
  }

  /** Fetch Reloadly gift-card products for a country (mirrors the frontend's fetchReloadlyList). */
  private async fetchReloadlyGiftCardProducts(countryCode: string): Promise<any[]> {
    const res = await this.reloadly.fetch(
      'giftcards',
      `${this.reloadly.getUrl('giftcards')}/countries/${countryCode}/products`,
      { headers: { Accept: 'application/com.reloadly.giftcards-v1+json' } }
    )

    if (!res.ok) {
      throw new PricingError('Unable to validate this order with the provider', 400)
    }

    const data = await res.json()
    return Array.isArray(data) ? data : data.content || []
  }

  /** Fetch Reloadly utility billers for a country (mirrors the frontend's fetchReloadlyList). */
  private async fetchReloadlyBillers(countryCode: string): Promise<any[]> {
    const res = await this.reloadly.fetch(
      'utilities',
      `${this.reloadly.getUrl('utilities')}/billers?countryISOCode=${countryCode}`,
      { headers: { Accept: 'application/com.reloadly.utilities-v1+json' } }
    )

    if (!res.ok) {
      throw new PricingError('Unable to validate this order with the provider', 400)
    }

    const data = await res.json()
    return Array.isArray(data) ? data : data.content || []
  }

  private async priceReloadlyTopup(
    order: TopupFulfillmentOrder,
    chargeCurrency: string
  ): Promise<number> {
    const operators = await this.fetchReloadlyOperators(order.countryCode)
    const operator = operators.find((o) => Number(o.operatorId) === Number(order.operatorId))
    if (!operator) {
      throw new PricingError('Operator is not available for this country', 400)
    }
    return priceTopupForOperator(order, operator, chargeCurrency)
  }

  /**
   * Reloadly gift cards. Ported verbatim from the frontend's `priceGiftCard`: validates
   * the requested recipient-facing amount against the product's real denominations
   * (FIXED: exact recipient→sender map lookup; RANGE: linear interpolation between
   * min/max recipient and sender denominations), then charges
   * `(senderBase + senderFee + senderBase * senderFeePercentage/100) * MARKUP` in the
   * product's sender currency, converted to `chargeCurrency`.
   */
  private async priceGiftCard(order: GiftCardFulfillmentOrder, chargeCurrency: string): Promise<number> {
    const products = await this.fetchReloadlyGiftCardProducts(order.countryCode)
    const product = products.find((p) => Number(p.productId) === Number(order.productId))
    if (!product) {
      throw new PricingError('Gift card product is not available', 400)
    }

    const recipientAmount = order.providerAmount
    let senderBase: number

    if (product.denominationType === 'FIXED') {
      const recipientDenoms = toNumberList(product.fixedRecipientDenominations)
      if (
        recipientDenoms.length > 0 &&
        !recipientDenoms.some((v) => Math.abs(v - recipientAmount) < 0.01)
      ) {
        throw new PricingError('Requested gift card amount is not offered', 400)
      }

      // Reloadly keys this map by stringified floats (e.g. "20.0"), so match numerically
      // rather than by exact string key.
      const map: Record<string, number> = product.fixedRecipientToSenderDenominationsMap || {}
      const senderEntry = Object.entries(map).find(
        ([key]) => Math.abs(Number(key) - recipientAmount) < 0.01
      )
      if (!senderEntry) {
        throw new PricingError('Requested gift card amount is not offered', 400)
      }
      senderBase = Number(senderEntry[1])
    } else {
      const minR = product.minRecipientDenomination
      const maxR = product.maxRecipientDenomination
      const minS = product.minSenderDenomination
      const maxS = product.maxSenderDenomination

      if (typeof minR === 'number' && typeof maxR === 'number') {
        if (recipientAmount < minR - 1e-6 || recipientAmount > maxR + 1e-6) {
          throw new PricingError('Requested gift card amount is outside the allowed range', 400)
        }
      }

      if (
        typeof minR === 'number' &&
        typeof maxR === 'number' &&
        typeof minS === 'number' &&
        typeof maxS === 'number' &&
        maxR > minR
      ) {
        const ratio = (recipientAmount - minR) / (maxR - minR)
        senderBase = minS + ratio * (maxS - minS)
      } else {
        senderBase = recipientAmount
      }
    }

    const ourCost =
      senderBase + (product.senderFee || 0) + (senderBase * (product.senderFeePercentage || 0)) / 100
    const senderCurrency = product.senderCurrencyCode || 'GBP'

    return roundToCurrencyDecimals(
      convertCurrency(ourCost * MARKUP, senderCurrency, chargeCurrency),
      chargeCurrency
    )
  }

  /**
   * Reloadly utility bill payments. Ported verbatim from the frontend's `priceUtility`:
   * validates the requested local amount against the biller's real min/max local
   * transaction bounds, then charges `(amount/fx.rate + fee/fx.rate) * MARKUP` — the cost
   * and fee are both converted into GBP (Reloadly's wallet currency) via the biller's own
   * fx rate when present, falling back to `convertCurrency` against `order.providerCurrency`
   * otherwise — and the GBP total is converted to `chargeCurrency`.
   */
  private async priceUtility(order: UtilityFulfillmentOrder, chargeCurrency: string): Promise<number> {
    const billers = await this.fetchReloadlyBillers(order.countryCode)
    const biller = billers.find((b) => Number(b.id) === Number(order.billerId))
    if (!biller) {
      throw new PricingError('Biller is not available', 400)
    }

    const amount = order.providerAmount
    const min = biller.minLocalTransactionAmount ?? biller.localMinAmount ?? biller.minAmount
    const max = biller.maxLocalTransactionAmount ?? biller.localMaxAmount ?? biller.maxAmount
    if (typeof min === 'number' && typeof max === 'number' && max > 0) {
      if (amount < min - 1e-6 || amount > max + 1e-6) {
        throw new PricingError('Requested amount is outside the biller limits', 400)
      }
    }

    let ourCost = biller.fx?.rate ? amount / biller.fx.rate : convertCurrency(amount, order.providerCurrency, 'GBP')

    const localFee = biller.localTransactionFee || 0
    if (localFee > 0) {
      ourCost += biller.fx?.rate
        ? localFee / biller.fx.rate
        : convertCurrency(localFee, biller.localTransactionFeeCurrencyCode || order.providerCurrency, 'GBP')
    }

    return roundToCurrencyDecimals(convertCurrency(ourCost * MARKUP, 'GBP', chargeCurrency), chargeCurrency)
  }

  /**
   * Compute the authoritative amount (in `chargeCurrency`) the customer must be charged
   * for this order, validating it against the provider's real product data. Throws a
   * PricingError if the order is invalid or out of bounds.
   *
   * SP-2 slice: the Reloadly topup/data, gift-card and utility (pay-bill) paths are
   * implemented. Any order that resolves to the PlanetTalk provider is out of scope here
   * and stubbed to a 501 PricingError; it arrives with the PlanetTalk utility executor.
   */
  async priceOrder(order: FulfillmentOrder, chargeCurrency: string): Promise<number> {
    if (order.productType === 'topup' || order.productType === 'data') {
      assertWithinGlobalLimits(order)
      return this.priceReloadlyTopup(order, chargeCurrency)
    }

    if (order.productType === 'giftcard') {
      assertWithinGlobalLimits(order)
      return this.priceGiftCard(order, chargeCurrency)
    }

    if (order.productType === 'utility') {
      // PlanetTalk utility pricing is out of scope for this SP-2 slice (it arrives with
      // the PlanetTalk utility executor); only the Reloadly path is priced here.
      const provider = resolveProvider(order.countryCode, order.productType)
      if (provider === 'planettalk') {
        throw new PricingError('Not implemented in SP-2 slice', 501)
      }
      assertWithinGlobalLimits(order)
      return this.priceUtility(order, chargeCurrency)
    }

    throw new PricingError('Not implemented in SP-2 slice', 501)
  }
}
