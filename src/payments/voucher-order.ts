// Pure helpers for the Gift Voucher (SureGifts via buhibab) product type.
import type { VoucherFulfillmentOrder } from './payments.types'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** Human-readable product line for receipts / admin, e.g. "SPAR gift voucher". */
export function voucherProductName(brand: string): string {
  return `${brand.trim()} gift voucher`.slice(0, 255)
}

/**
 * Shape checks that need no provider data. The amount is checked against the brand's live
 * bounds in PricingService, which has the catalog in hand.
 */
export function validateVoucherOrder(order: VoucherFulfillmentOrder): string | null {
  if (order.countryCode.toUpperCase() !== 'NG') return 'Gift vouchers are only available in Nigeria (NG)'
  if (order.providerCurrency.toUpperCase() !== 'NGN') return 'providerCurrency must be NGN'
  if (!order.productId) return 'productId is required'
  if (!order.email?.trim() || !EMAIL_RE.test(order.email.trim())) return 'A valid email is required'
  if (order.recipientEmail && !EMAIL_RE.test(order.recipientEmail.trim())) {
    return 'Recipient email is not valid'
  }
  // buhibab takes whole naira; a fractional face value would be rounded upstream and the
  // signed amount would no longer be what was delivered.
  if (!Number.isInteger(order.providerAmount)) return 'Voucher amount must be a whole number of naira'
  return null
}

/** One voucher as buhibab issued it. A purchase may in principle return several. */
export interface IssuedVoucher {
  code: string
  pin?: string
  serial?: string
  /** ISO timestamp, as buhibab sends it. */
  expiresAt?: string
  /** Face value in NGN. */
  value?: number
}

const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' && Number.isFinite(v) ? String(v) : undefined

/**
 * The vouchers in a buhibab purchase response. buhibab returns them under
 * `data.meta.vouchers`, observed on the first live order (2026-10-22):
 *
 *   { vouchers: [{ code: "3211…", pin: "7545", value: 10000, serial: 301126367,
 *                  expiry_date: "2027-10-22T11:48:04Z" }], order_number: "453988" }
 *
 * Entries without a code are dropped. An empty result means nothing deliverable came back.
 */
export function extractIssuedVouchers(data: unknown): IssuedVoucher[] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  const meta = (data as Record<string, unknown>).meta
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return []
  const list = (meta as Record<string, unknown>).vouchers
  if (!Array.isArray(list)) return []

  return list.flatMap((entry): IssuedVoucher[] => {
    if (!entry || typeof entry !== 'object') return []
    const v = entry as Record<string, unknown>
    const code = str(v.code)
    if (!code) return []
    const value = typeof v.value === 'number' && v.value > 0 ? v.value : undefined
    return [
      {
        code,
        ...(str(v.pin) ? { pin: str(v.pin) } : {}),
        ...(str(v.serial) ? { serial: str(v.serial) } : {}),
        ...(str(v.expiry_date) ? { expiresAt: str(v.expiry_date) } : {}),
        ...(value ? { value } : {}),
      },
    ]
  })
}
