// Pure validation/normalisation of a landing-page submission, and the duplicate/fraud
// flags raised on it. Flags never reject on their own: shared household contacts are
// legitimate, so a flagged case goes to a reviewer (brief §3, fraud/duplicate controls).
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { toE164Digits } from '../common/phone'

export const RELATIONSHIPS = ['parent', 'sibling', 'spouse_partner', 'child', 'other', 'prefer_not_to_say'] as const
export const CONTACT_CHANNELS = ['sms', 'phone_call', 'whatsapp', 'email'] as const

export interface SubmissionInput {
  senderName?: unknown
  senderEmail?: unknown
  senderPhone?: unknown
  recipientName?: unknown
  recipientPhone?: unknown
  recipientEmail?: unknown
  relationship?: unknown
  preferredContact?: unknown
  declarationAccepted?: unknown
  termsAccepted?: unknown
  termsVersion?: unknown
}

export interface NormalisedSubmission {
  senderName: string
  senderEmail: string
  senderPhone: string
  recipientName: string
  recipientPhone: string
  recipientEmail: string | null
  relationship: string | null
  preferredContact: string | null
  termsVersion: string
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const E164_RE = /^\+[1-9]\d{6,14}$/

const text = (v: unknown) => (typeof v === 'string' ? v.trim().replace(/\s+/g, ' ') : '')

/** Strict E.164 (a '+' then digits, no spaces) that libphonenumber also accepts as a real number. */
export function isE164(phone: string): boolean {
  if (!E164_RE.test(phone)) return false
  return parsePhoneNumberFromString(phone)?.isValid() ?? false
}

/** A Nigerian number in E.164 (+234 and exactly 10 national digits), or null. */
export function normaliseNigerianPhone(raw: string): string | null {
  if (!raw.startsWith('+234')) return null
  const digits = toE164Digits(raw, 'NG')
  return digits ? `+${digits}` : null
}

export function validateSubmission(
  input: SubmissionInput,
): { ok: true; value: NormalisedSubmission } | { ok: false; errors: string[] } {
  const errors: string[] = []

  const senderName = text(input.senderName)
  const senderEmail = text(input.senderEmail).toLowerCase()
  const senderPhone = text(input.senderPhone).replace(/[\s()-]/g, '')
  const recipientName = text(input.recipientName)
  const recipientPhoneRaw = text(input.recipientPhone).replace(/[\s()-]/g, '')
  const recipientEmail = text(input.recipientEmail).toLowerCase() || null
  const relationship = text(input.relationship) || null
  const preferredContact = text(input.preferredContact) || null
  const termsVersion = text(input.termsVersion)

  if (senderName.length < 2 || senderName.length > 120) errors.push('Enter your full name')
  if (!EMAIL_RE.test(senderEmail) || senderEmail.length > 254) errors.push('Enter a valid email address for yourself')
  if (!isE164(senderPhone)) errors.push('Enter your phone number in international format, e.g. +447700900000')
  if (recipientName.length < 2 || recipientName.length > 120) errors.push("Enter the recipient's full name")

  const recipientPhone = normaliseNigerianPhone(recipientPhoneRaw)
  if (!recipientPhone) errors.push("Enter the recipient's Nigerian mobile number, starting +234")

  if (recipientEmail && (!EMAIL_RE.test(recipientEmail) || recipientEmail.length > 254)) {
    errors.push("The recipient's email address is not valid")
  }
  if (relationship && !(RELATIONSHIPS as readonly string[]).includes(relationship)) errors.push('Choose a valid relationship')
  if (preferredContact && !(CONTACT_CHANNELS as readonly string[]).includes(preferredContact)) {
    errors.push('Choose a valid contact method')
  }
  if (preferredContact === 'email' && !recipientEmail) {
    errors.push('Add the recipient email address to use email as the contact method')
  }
  if (input.declarationAccepted !== true) {
    errors.push("Confirm you have permission to share the recipient's details")
  }
  if (input.termsAccepted !== true) errors.push('Accept the campaign terms')
  if (!termsVersion) errors.push('termsVersion is required')

  if (errors.length || !recipientPhone) return { ok: false, errors }
  return {
    ok: true,
    value: {
      senderName,
      senderEmail,
      senderPhone,
      recipientName,
      recipientPhone,
      recipientEmail,
      relationship,
      preferredContact,
      termsVersion,
    },
  }
}

export type GiftFlag =
  | 'DUPLICATE_RECIPIENT_PHONE'
  | 'DUPLICATE_RECIPIENT_EMAIL'
  | 'REPEAT_SENDER'
  | 'RECIPIENT_IS_SENDER'
  | 'SENDER_DETAILS_CHANGED'
  | 'QUALIFYING_ORDER_NOT_SETTLED'

export interface FlagContext {
  submission: NormalisedSubmission
  account: { email: string; phone: string }
  order: { status: string; refunded: boolean; disputed: boolean }
  /** Other submissions in this campaign nominating the same recipient phone. */
  otherSubmissionsSameRecipientPhone: number
  /** ...or the same recipient email (0 when none given). */
  otherSubmissionsSameRecipientEmail: number
  /** Other submissions in this campaign by the same customer account. */
  otherSubmissionsSameCustomer: number
}

export function computeFlags(ctx: FlagContext): GiftFlag[] {
  const flags: GiftFlag[] = []
  const { submission: s, account } = ctx
  if (ctx.otherSubmissionsSameRecipientPhone > 0) flags.push('DUPLICATE_RECIPIENT_PHONE')
  if (ctx.otherSubmissionsSameRecipientEmail > 0) flags.push('DUPLICATE_RECIPIENT_EMAIL')
  if (ctx.otherSubmissionsSameCustomer > 0) flags.push('REPEAT_SENDER')
  if (s.recipientPhone === s.senderPhone || s.recipientPhone === account.phone) flags.push('RECIPIENT_IS_SENDER')
  if (s.senderEmail !== account.email.toLowerCase() || s.senderPhone !== account.phone) flags.push('SENDER_DETAILS_CHANGED')
  if (ctx.order.status !== 'FULFILLED' || ctx.order.refunded || ctx.order.disputed) flags.push('QUALIFYING_ORDER_NOT_SETTLED')
  return flags
}
