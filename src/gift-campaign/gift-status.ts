// Status workflow for campaign submissions. Pure — the services enforce it with guarded
// updates (WHERE status = from), so two reviewers can never both move the same case.
import type { GiftSubmissionStatus } from '@prisma/client'

export const SUBMISSION_STATUSES: readonly GiftSubmissionStatus[] = [
  'SUBMITTED',
  'PENDING_VALIDATION',
  'APPROVED',
  'REJECTED',
  'RECIPIENT_CONTACTED',
  'AWAITING_REDEMPTION',
  'FULFILLED',
  'SENDER_NOTIFIED',
  'ESCALATED',
  'CANCELLED',
]

/**
 * Allowed moves. Notes:
 *  - Submission is never approval: SUBMITTED/PENDING_VALIDATION only reach APPROVED by a
 *    reviewer.
 *  - AWAITING_REDEMPTION is normally reached by issuing the voucher; a manual move covers
 *    fulfilment outside the system (e.g. in-person collection arranged by ops).
 *  - FULFILLED is never automatic; it needs a reviewer with evidence (a note).
 *  - FULFILLED -> SENDER_NOTIFIED happens automatically when the completion email is sent;
 *    manual for when ops told the sender another way.
 *  - REJECTED -> ESCALATED covers a disputed rejection.
 */
export const TRANSITIONS: Readonly<Record<GiftSubmissionStatus, readonly GiftSubmissionStatus[]>> = {
  SUBMITTED: ['PENDING_VALIDATION', 'REJECTED', 'ESCALATED', 'CANCELLED'],
  PENDING_VALIDATION: ['APPROVED', 'REJECTED', 'ESCALATED', 'CANCELLED'],
  ESCALATED: ['PENDING_VALIDATION', 'APPROVED', 'REJECTED', 'CANCELLED'],
  APPROVED: ['RECIPIENT_CONTACTED', 'AWAITING_REDEMPTION', 'ESCALATED', 'CANCELLED'],
  RECIPIENT_CONTACTED: ['AWAITING_REDEMPTION', 'ESCALATED', 'CANCELLED'],
  AWAITING_REDEMPTION: ['FULFILLED', 'ESCALATED'],
  FULFILLED: ['SENDER_NOTIFIED'],
  REJECTED: ['ESCALATED'],
  SENDER_NOTIFIED: [],
  CANCELLED: [],
}

export const REJECT_REASONS = [
  'INELIGIBLE_TRANSACTION',
  'TRANSACTION_REVERSED',
  'DUPLICATE_RECIPIENT',
  'DUPLICATE_SENDER',
  'CAMPAIGN_LIMIT_REACHED',
  'INVALID_DETAILS',
  'RECIPIENT_NOT_IN_NIGERIA',
  'RECIPIENT_DECLINED',
  'SUSPECTED_FRAUD',
  'OTHER',
] as const

export const ESCALATION_REASONS = [
  'FRAUD_REVIEW',
  'ELIGIBILITY_MISMATCH',
  'DUPLICATE_FLAGS',
  'RECIPIENT_UNREACHABLE',
  'VOUCHER_ISSUE_FAILED',
  'NOTIFICATION_FAILED',
  'DISPUTED_REJECTION',
  'FULFILMENT_DELAYED',
  'OTHER',
] as const

export const CANCEL_REASONS = ['SENDER_REQUEST', 'RECIPIENT_UNREACHABLE', 'RECIPIENT_DECLINED', 'EXPIRED', 'OTHER'] as const

export const REASONS_BY_STATUS: Partial<Record<GiftSubmissionStatus, readonly string[]>> = {
  REJECTED: REJECT_REASONS,
  ESCALATED: ESCALATION_REASONS,
  CANCELLED: CANCEL_REASONS,
}

/** Statuses a reviewer must justify with a note (evidence of fulfilment, or what 'OTHER' means). */
const NOTE_REQUIRED: readonly GiftSubmissionStatus[] = ['FULFILLED']

export class GiftTransitionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GiftTransitionError'
  }
}

export function canTransition(from: GiftSubmissionStatus, to: GiftSubmissionStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** Throws GiftTransitionError when the move or its justification is not allowed. */
export function assertTransition(
  from: GiftSubmissionStatus,
  to: GiftSubmissionStatus,
  reasonCode?: string | null,
  note?: string | null,
): void {
  if (!canTransition(from, to)) {
    throw new GiftTransitionError(`Cannot move a submission from ${from} to ${to}`)
  }
  const reasons = REASONS_BY_STATUS[to]
  if (reasons) {
    if (!reasonCode) throw new GiftTransitionError(`A reason code is required to move to ${to}`)
    if (!reasons.includes(reasonCode)) {
      throw new GiftTransitionError(`Reason ${reasonCode} is not valid for ${to} (expected one of ${reasons.join(', ')})`)
    }
    if (reasonCode === 'OTHER' && !note?.trim()) {
      throw new GiftTransitionError('A note is required when the reason is OTHER')
    }
  } else if (reasonCode) {
    throw new GiftTransitionError(`${to} does not take a reason code`)
  }
  if (NOTE_REQUIRED.includes(to) && !note?.trim()) {
    throw new GiftTransitionError(`A note recording the evidence is required to move to ${to}`)
  }
}

/** What the sender may be told. Never says "confirmed" before approval (brief §6, promise control). */
export function customerStatusLabel(status: GiftSubmissionStatus): string {
  switch (status) {
    case 'SUBMITTED':
    case 'PENDING_VALIDATION':
    case 'ESCALATED':
      return 'Your details are being checked'
    case 'APPROVED':
    case 'RECIPIENT_CONTACTED':
    case 'AWAITING_REDEMPTION':
      return 'Approved - we are arranging the gift with your recipient'
    case 'FULFILLED':
    case 'SENDER_NOTIFIED':
      return 'Delivered to your recipient'
    case 'REJECTED':
      return 'Not approved'
    case 'CANCELLED':
      return 'Cancelled'
  }
}

/**
 * Customer-safe explanation for a rejection. Fraud-type reasons are deliberately vague.
 */
export function customerRejectionReason(reasonCode: string | null | undefined): string | null {
  switch (reasonCode) {
    case 'INELIGIBLE_TRANSACTION':
      return 'the qualifying top-up does not meet the campaign requirements'
    case 'TRANSACTION_REVERSED':
      return 'the qualifying top-up was refunded or reversed'
    case 'DUPLICATE_RECIPIENT':
      return 'this recipient has already been nominated in the campaign'
    case 'DUPLICATE_SENDER':
    case 'CAMPAIGN_LIMIT_REACHED':
      return 'the campaign limit for your account has been reached'
    case 'INVALID_DETAILS':
      return 'we could not verify the details provided'
    case 'RECIPIENT_NOT_IN_NIGERIA':
      return 'the recipient must be in Nigeria'
    case 'RECIPIENT_DECLINED':
      return 'the recipient did not wish to be contacted'
    default:
      return null
  }
}
