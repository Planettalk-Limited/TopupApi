import { BadRequestException } from '@nestjs/common'

/**
 * The only currencies a customer can be shown or charged in. Must match the
 * frontend's DISPLAY_CURRENCIES (TopupApp src/lib/currency.ts): customers whose
 * local currency is one of these see it, everyone else sees USD.
 */
export const CHARGE_CURRENCIES = ['gbp', 'usd', 'cad', 'eur', 'zar'] as const

/**
 * Normalises a client-supplied charge currency (default USD) and rejects anything
 * outside CHARGE_CURRENCIES. Rejecting rather than coercing to USD keeps the charge in
 * the currency the customer was shown — a stale client would otherwise be charged in a
 * currency it never displayed.
 */
export function resolveChargeCurrency(raw: string | undefined): string {
  const currency = (raw || 'usd').toLowerCase()
  if (!(CHARGE_CURRENCIES as readonly string[]).includes(currency)) {
    throw new BadRequestException(
      `Unsupported currency: ${currency.toUpperCase()}. Supported: ${CHARGE_CURRENCIES.join(', ').toUpperCase()}.`,
    )
  }
  return currency
}
