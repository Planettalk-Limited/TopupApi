// Pure helpers for the Healthcare (WellaHealth pharmacy via buhibab) product type.
//
// A pharmacy order's patient + medication details are medical PII and too large for
// Stripe metadata (500 chars / value). They live on `orders.details` instead, and Stripe
// carries only `detailsHash`. Integrity is preserved two ways:
//   - the HMAC binding signature (signature.service.ts) covers the hash, so a crafted
//     intent cannot point at different details;
//   - fulfilment re-hashes the row it loads and refuses on mismatch, so the row cannot be
//     edited between checkout and fulfilment either.
import { createHash } from 'crypto'
import { isValidRecipientPhone } from '../common/phone'
import type { HealthcareDetails, HealthcareFulfillmentOrder } from './payments.types'

/** buhibab product id of "WellaHealth Pharmacy Purchase" (sub-service "Pharmacy"). */
export const HEALTHCARE_PRODUCT_ID = Number(process.env.HEALTHCARE_PRODUCT_ID || 1951)

export const HEALTHCARE_MAX_LINES = 5
export const HEALTHCARE_MAX_QUANTITY = 10
/** Sent as the drug's `dose` when the customer gives none — buhibab requires one. */
export const HEALTHCARE_DEFAULT_DOSE = 'As directed'
/** What Stripe sees as the product name — the real one lists medications. */
export const HEALTHCARE_METADATA_PRODUCT_NAME = 'Pharmacy order'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
// Buyer may be anywhere in the world, so this is a loose sanity check, not a dialling-plan
// validation: 7-15 digits with an optional leading '+'.
const LOOSE_PHONE_RE = /^\+?\d{7,15}$/

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Deterministic SHA-256 of the details — key order and undefined fields don't matter. */
export function hashHealthcareDetails(details: HealthcareDetails): string {
  return createHash('sha256').update(stableStringify(details)).digest('hex')
}

/** Provider-side value of the order in NGN: sum of pack price x quantity. */
export function healthcareProviderTotal(details: HealthcareDetails): number {
  const total = details.drugs.reduce((sum, d) => sum + d.unitPrice * d.quantity, 0)
  return Math.round(total * 100) / 100
}

/** Human-readable product line for receipts / admin, e.g. "Pharmacy: EMZOR ... x2, ...". */
export function healthcareProductName(details: HealthcareDetails): string {
  const items = details.drugs.map((d) => `${d.drugName} x${d.quantity}`).join(', ')
  return `Pharmacy: ${items}`.slice(0, 255)
}

export function validateHealthcareOrder(order: HealthcareFulfillmentOrder): string | null {
  if (order.countryCode.toUpperCase() !== 'NG') return 'Healthcare is only available in Nigeria (NG)'
  if (order.providerCurrency.toUpperCase() !== 'NGN') return 'providerCurrency must be NGN'
  if (!order.email?.trim() || !EMAIL_RE.test(order.email.trim())) return 'A valid email is required'

  const d = order.details
  if (!d) return 'Order details are required'
  if (!d.pharmacyCode?.trim()) return 'pharmacyCode is required'
  if (!d.buyerPhone?.trim() || !LOOSE_PHONE_RE.test(d.buyerPhone.replace(/[\s\-()]/g, ''))) {
    return 'A valid phone number is required'
  }

  const p = d.patient
  if (!p) return 'Beneficiary details are required'
  if (!p.firstName?.trim() || !p.lastName?.trim()) return 'Beneficiary first and last name are required'
  if (p.gender !== 'Male' && p.gender !== 'Female') return 'Beneficiary gender must be Male or Female'
  if (!p.address?.trim()) return 'Beneficiary address is required'
  if (!p.phone?.trim() || !isValidRecipientPhone(p.phone, 'NG')) {
    return 'Beneficiary phone must be a valid Nigerian number'
  }
  if (p.email && !EMAIL_RE.test(p.email.trim())) return 'Beneficiary email is not valid'

  if (!Array.isArray(d.drugs) || d.drugs.length === 0) return 'Select at least one medication'
  if (d.drugs.length > HEALTHCARE_MAX_LINES) return `At most ${HEALTHCARE_MAX_LINES} medications per order`
  const seen = new Set<string>()
  for (const line of d.drugs) {
    if (!line.drugName?.trim()) return 'Each medication needs a name'
    if (seen.has(line.drugName)) return 'Each medication may appear only once — adjust its quantity instead'
    seen.add(line.drugName)
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > HEALTHCARE_MAX_QUANTITY) {
      return `Quantity must be a whole number from 1 to ${HEALTHCARE_MAX_QUANTITY}`
    }
    if (!(line.unitPrice > 0)) return 'Medication price is missing'
  }

  // providerAmount is what gets priced and signed; it must be exactly the lines' value so
  // the signed amount, the Order row and what buhibab bills us can never drift apart.
  if (Math.abs(healthcareProviderTotal(d) - order.providerAmount) > 0.01) {
    return 'Order total does not match the medication prices'
  }
  return null
}

export class HealthcareIntegrityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HealthcareIntegrityError'
  }
}

/**
 * Re-attach the persisted details to an order parsed from Stripe metadata, refusing if
 * they no longer hash to the value the intent was minted with.
 */
export function hydrateHealthcareOrder(
  order: HealthcareFulfillmentOrder,
  rowDetails: unknown,
): HealthcareFulfillmentOrder {
  if (!rowDetails || typeof rowDetails !== 'object' || Array.isArray(rowDetails)) {
    throw new HealthcareIntegrityError('Healthcare order details are missing')
  }
  const details = rowDetails as HealthcareDetails
  if (!order.detailsHash || hashHealthcareDetails(details) !== order.detailsHash) {
    throw new HealthcareIntegrityError('Healthcare order details do not match the payment')
  }
  // Stripe only carries a generic product name; restore the descriptive one for receipts.
  return { ...order, details, productName: healthcareProductName(details) }
}
