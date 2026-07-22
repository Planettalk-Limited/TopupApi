// Ported from TopupApp/src/lib/fulfillment/signature.ts, wrapped as a NestJS
// Injectable service. Logic (canonicalize, HMAC-SHA256, timingSafeEqual) is
// preserved verbatim.
import { Injectable } from '@nestjs/common'
import { createHmac, timingSafeEqual } from 'crypto'
import type { FulfillmentOrder } from './payments.types'

/**
 * Fulfillment binding signature.
 *
 * SECURITY: `/api/fulfill` is unauthenticated (the browser must call it after payment), and
 * anyone holding a Stripe secret key can create a `succeeded` PaymentIntent with arbitrary
 * metadata. To stop a crafted intent from being fulfilled, every intent created by our own
 * `/api/stripe/create-payment-intent` route carries an HMAC over the order + authoritative
 * charge, keyed by a server-only secret (`FULFILLMENT_SIGNING_SECRET`). Fulfillment recomputes
 * and verifies it. An attacker cannot produce a valid signature for a crafted order without
 * the secret, so intents not minted by our route are refused — independent of the re-pricing
 * backstop in `assertPaidEnough`.
 *
 * The signature covers the full order plus the charge amount/currency, so it cannot be lifted
 * from a cheap legitimate intent and replayed onto a different (expensive) order.
 */

export const FULFILLMENT_SIG_META = 'fulfillmentSig'

/** Deterministic, order-independent serialization of the fields that define an order. */
function canonicalize(
  order: FulfillmentOrder,
  chargeAmount: string,
  chargeCurrency: string
): string {
  const fields: Record<string, string | number | boolean | undefined> = {
    productType: order.productType,
    countryCode: order.countryCode.toUpperCase(),
    providerAmount: order.providerAmount,
    providerCurrency: order.providerCurrency.toUpperCase(),
    chargeAmount,
    chargeCurrency: chargeCurrency.toUpperCase(),
  }

  if (order.productType === 'topup' || order.productType === 'data') {
    fields.operatorId = order.operatorId
    fields.recipientPhone = order.recipientPhone
    fields.useLocalAmount = order.useLocalAmount
  } else if (order.productType === 'giftcard') {
    fields.productId = order.productId
    fields.recipientEmail = order.recipientEmail
  } else if (order.productType === 'utility') {
    fields.billerId = order.billerId
    fields.accountNumber = order.accountNumber
  }

  // Sort keys so the string is stable regardless of property insertion order.
  return Object.keys(fields)
    .sort()
    .map((k) => `${k}=${fields[k] ?? ''}`)
    .join('&')
}

@Injectable()
export class SignatureService {
  hasSecret(): boolean {
    return Boolean(process.env.FULFILLMENT_SIGNING_SECRET)
  }

  /** Computes the binding signature for an order. Throws if the signing secret is unset. */
  sign(order: FulfillmentOrder, chargeAmount: string, chargeCurrency: string): string {
    const secret = process.env.FULFILLMENT_SIGNING_SECRET
    if (!secret) {
      throw new Error('FULFILLMENT_SIGNING_SECRET is not configured')
    }
    return createHmac('sha256', secret)
      .update(canonicalize(order, chargeAmount, chargeCurrency))
      .digest('hex')
  }

  /**
   * Verifies the binding signature stored on a PaymentIntent against the order. Returns false on
   * any mismatch, missing signature, or missing/garbled inputs (fail closed).
   */
  verify(
    order: FulfillmentOrder,
    chargeAmount: string,
    chargeCurrency: string,
    providedSig: string | undefined
  ): boolean {
    if (!providedSig) return false

    let expected: string
    try {
      expected = this.sign(order, chargeAmount, chargeCurrency)
    } catch {
      return false
    }

    const a = Buffer.from(expected)
    const b = Buffer.from(providedSig)
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }
}
