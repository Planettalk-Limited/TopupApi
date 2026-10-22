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

const CODE_KEYS = ['code', 'voucher_code', 'voucherCode', 'pin', 'voucher_pin', 'voucherPin', 'token', 'serial']

/**
 * Pull the voucher code out of a purchase response, if buhibab returns one. The response
 * shape for this product is not documented, so look in the places buhibab puts provider
 * output on other products (`data.meta`, `data`) under the names a voucher code plausibly
 * has. Returns null when the code is only emailed.
 */
export function extractVoucherCode(data: unknown): { cardCode: string; cardPin?: string } | null {
  const sources: Record<string, unknown>[] = []
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const d = data as Record<string, unknown>
    if (d.meta && typeof d.meta === 'object' && !Array.isArray(d.meta)) sources.push(d.meta as Record<string, unknown>)
    sources.push(d)
  }
  for (const source of sources) {
    const code = CODE_KEYS.map((k) => source[k]).find((v) => typeof v === 'string' && v.trim())
    if (typeof code === 'string') {
      const pin = ['pin', 'voucher_pin', 'voucherPin'].map((k) => source[k]).find((v) => typeof v === 'string' && v.trim() && v !== code)
      return { cardCode: code.trim(), ...(typeof pin === 'string' ? { cardPin: pin.trim() } : {}) }
    }
  }
  return null
}
