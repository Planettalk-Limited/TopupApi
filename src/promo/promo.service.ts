// Promo codes (webmart review D.4). Discounts are computed ONLY here, on the server,
// from the server's own price for the order (PricingService.priceOrder) — the client
// never supplies an amount. See payments.controller.ts for where the discounted total
// becomes the signed, authoritative charge.
import { Injectable, Logger } from '@nestjs/common'
import type { PromoCode } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { convertCurrency, getStripeLimits } from '../payments/static-fx'

export type PromoErrorCode =
  | 'PROMO_NOT_FOUND'
  | 'PROMO_INACTIVE'
  | 'PROMO_NOT_STARTED'
  | 'PROMO_EXPIRED'
  | 'PROMO_NOT_APPLICABLE'
  | 'PROMO_MIN_ORDER'
  | 'PROMO_EXHAUSTED'
  | 'PROMO_ALREADY_USED'
  | 'PROMO_ORDER_TOO_SMALL'

export class PromoError extends Error {
  constructor(
    readonly code: PromoErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'PromoError'
  }
}

export interface PromoQuote {
  promo: PromoCode
  /** Amount taken off, in the charge currency. */
  discount: number
  /** What the customer pays: subtotal - discount, never below Stripe's minimum. */
  total: number
}

export function normalizePromoCode(code: string): string {
  return String(code ?? '').trim().toUpperCase()
}

/**
 * Discount for a subtotal (both in `currency`). Capped by maxDiscountGbp, and capped so
 * the remaining charge is never below Stripe's minimum for the currency (which also
 * caps it below the subtotal). Rounded DOWN to the currency's minor unit, so rounding
 * never gives away more than the promo says.
 */
export function computePromoDiscount(
  promo: Pick<PromoCode, 'discountType' | 'value' | 'maxDiscountGbp'>,
  subtotal: number,
  currency: string,
): { discount: number; total: number } {
  const { decimals, minimum } = getStripeLimits(currency)
  const factor = Math.pow(10, decimals)

  let raw =
    promo.discountType === 'PERCENT'
      ? (subtotal * Math.min(Math.max(Number(promo.value), 0), 100)) / 100
      : convertCurrency(Number(promo.value), 'GBP', currency)

  if (promo.maxDiscountGbp !== null && promo.maxDiscountGbp !== undefined) {
    raw = Math.min(raw, convertCurrency(Number(promo.maxDiscountGbp), 'GBP', currency))
  }
  raw = Math.min(raw, subtotal - minimum)

  const discount = raw > 0 ? Math.floor(raw * factor + 1e-6) / factor : 0
  const total = Math.round((subtotal - discount) * factor) / factor
  return { discount, total }
}

@Injectable()
export class PromoService {
  private readonly logger = new Logger(PromoService.name)

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Validate `code` for this customer/order and price the discount. Throws PromoError
   * (with a customer-facing message) when the code cannot be used. Limits counted here are
   * PAID redemptions; they are re-checked under a row lock when the order is paid
   * (see promo-redemption.ts), which is what actually stops concurrent over-use.
   * Every rejection is logged with its reason code, so "why did my code fail" is one grep.
   */
  async quote(input: {
    code: string
    customerId: string
    productType: string
    subtotal: number
    currency: string
  }): Promise<PromoQuote> {
    try {
      return await this.priceQuote(input)
    } catch (error) {
      if (error instanceof PromoError) {
        this.logger.warn(
          `Promo ${error.code} code=${normalizePromoCode(input.code)} customer=${input.customerId} ` +
            `product=${input.productType} subtotal=${input.subtotal} ${input.currency}: ${error.message}`,
        )
      }
      throw error
    }
  }

  private async priceQuote(input: {
    code: string
    customerId: string
    productType: string
    subtotal: number
    currency: string
  }): Promise<PromoQuote> {
    const code = normalizePromoCode(input.code)
    const promo = code ? await this.prisma.promoCode.findUnique({ where: { code } }) : null
    if (!promo) throw new PromoError('PROMO_NOT_FOUND', 'This promo code is not valid')
    if (!promo.active) throw new PromoError('PROMO_INACTIVE', 'This promo code is no longer active')

    const now = Date.now()
    if (promo.startsAt && promo.startsAt.getTime() > now) {
      throw new PromoError('PROMO_NOT_STARTED', 'This promo code is not active yet')
    }
    if (promo.endsAt && promo.endsAt.getTime() <= now) {
      throw new PromoError('PROMO_EXPIRED', 'This promo code has expired')
    }
    if (promo.productTypes.length > 0 && !promo.productTypes.includes(input.productType)) {
      throw new PromoError('PROMO_NOT_APPLICABLE', 'This promo code cannot be used for this product')
    }
    if (promo.minOrderGbp !== null) {
      const subtotalGbp = convertCurrency(input.subtotal, input.currency, 'GBP')
      if (subtotalGbp + 1e-6 < Number(promo.minOrderGbp)) {
        throw new PromoError(
          'PROMO_MIN_ORDER',
          `This promo code needs a minimum order of £${Number(promo.minOrderGbp).toFixed(2)}`,
        )
      }
    }

    const [total, mine] = await Promise.all([
      promo.maxRedemptions !== null ? this.prisma.promoRedemption.count({ where: { promoCodeId: promo.id } }) : 0,
      this.prisma.promoRedemption.count({ where: { promoCodeId: promo.id, customerId: input.customerId } }),
    ])
    if (promo.maxRedemptions !== null && total >= promo.maxRedemptions) {
      throw new PromoError('PROMO_EXHAUSTED', 'This promo code has been fully redeemed')
    }
    if (mine >= promo.perCustomerLimit) {
      throw new PromoError('PROMO_ALREADY_USED', 'You have already used this promo code')
    }

    const { discount, total: charge } = computePromoDiscount(promo, input.subtotal, input.currency)
    if (discount <= 0) {
      throw new PromoError('PROMO_ORDER_TOO_SMALL', 'This order is too small for a discount')
    }
    return { promo, discount, total: charge }
  }
}
