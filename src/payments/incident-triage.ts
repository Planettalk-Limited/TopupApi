/**
 * Triage for the Reloadly INVALID_RECIPIENT_PHONE incident.
 *
 * Background: the top-up executor used to strip the dialling code off
 * `recipientPhone` with a length heuristic, so Reloadly re-prefixed the country code
 * and rejected a number that did not exist — 400 "Recipient phone number is not
 * valid", AFTER Stripe had charged the customer. See src/common/phone.ts.
 *
 * This classifies each FAILED fulfilment into what should actually happen to it, so a
 * remediation run never has to guess. It is pure and read-only; acting on the verdict
 * is the caller's job (admin retry / admin refund endpoints).
 */
import { toE164Digits } from '../common/phone'
import { MAX_ATTEMPTS } from './fulfillment.constants'

/**
 * Wordings that identify this incident: Reloadly's own message (which the executor
 * stores verbatim into `lastError`), our replacement executor's message, and the raw
 * error code in case it ever reaches the column.
 */
export const PHONE_INCIDENT_SIGNATURE = /recipient phone number is not valid|invalid_recipient_phone/i

export type TriageBucket =
  /** Reconciliation will retry it on its own once the fix is deployed — do nothing. */
  | 'SELF_HEALS'
  /** Out of automatic attempts, but the number is deliverable — needs an admin retry. */
  | 'NEEDS_RETRY'
  /** The number cannot be delivered to by anyone — the customer must be refunded. */
  | 'NEEDS_REFUND'
  /** Not this incident. Must be looked at by hand; never bulk-retried. */
  | 'UNRELATED'

export interface FailedFulfillmentRow {
  productType: string
  countryCode: string
  recipientPhone: string | null
  lastError: string | null
  attempts: number
}

export interface TriageVerdict {
  bucket: TriageBucket
  /** The number the fixed executor would send to Reloadly, or null if unparseable. */
  wouldSend: string | null
  reason: string
}

export function classifyFailedFulfillment(row: FailedFulfillmentRow): TriageVerdict {
  // Prisma hands back the uppercase DB enum (TOPUP/DATA); the fulfilment order types use
  // lowercase. Accept either so a caller cannot silently get an all-UNRELATED report.
  const productType = String(row.productType ?? '').toLowerCase()
  const phoneBearing = productType === 'topup' || productType === 'data'

  // SAFETY: only a 400 on the phone proves Reloadly created nothing, which is what makes
  // a replay safe. A timeout or connection reset may have moved value at the provider
  // without us recording it, so anything that is not this incident stays out of scope.
  if (!phoneBearing || !row.lastError || !PHONE_INCIDENT_SIGNATURE.test(row.lastError)) {
    return {
      bucket: 'UNRELATED',
      wouldSend: null,
      reason: 'Not the phone incident — replaying could double-deliver. Inspect by hand.',
    }
  }

  const wouldSend = row.recipientPhone ? toE164Digits(row.recipientPhone, row.countryCode) : null

  if (!wouldSend) {
    return {
      bucket: 'NEEDS_REFUND',
      wouldSend: null,
      reason: `"${row.recipientPhone}" is not a valid number for ${row.countryCode} — no retry can ever deliver it.`,
    }
  }

  if (row.attempts < MAX_ATTEMPTS) {
    return {
      bucket: 'SELF_HEALS',
      wouldSend,
      reason: `${row.attempts}/${MAX_ATTEMPTS} attempts used — the reconciliation worker will retry this automatically.`,
    }
  }

  return {
    bucket: 'NEEDS_RETRY',
    wouldSend,
    reason: `Exhausted ${row.attempts}/${MAX_ATTEMPTS} automatic attempts, but ${wouldSend} is deliverable.`,
  }
}
