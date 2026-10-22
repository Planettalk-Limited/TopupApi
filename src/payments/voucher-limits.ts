// Fraud limits for gift vouchers (SureGifts via buhibab).
//
// A voucher is as good as cash and is spent within minutes, so a stolen card is worth
// more turned into vouchers than almost anything else we sell, and the chargeback lands
// weeks after the value is gone. Two caps bound what one buyer can take in a day:
//
//   - per buyer email, checked when the payment intent is created (cheap, but an email
//     is free to change), and
//   - per card, by Stripe's card fingerprint, checked at fulfilment — the first moment
//     the card is known, and still before anything is bought from buhibab.
//
// Both count orders that took money or are about to (PAID, FULFILLED) over a rolling
// 24 hours, against VOUCHER_DAILY_MAX_NGN of face value.
import type { Prisma } from '@prisma/client'

export const VOUCHER_DAILY_MAX_NGN = Number(process.env.VOUCHER_DAILY_MAX_NGN || 100_000)

const WINDOW_MS = 24 * 60 * 60 * 1000

export class VoucherLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'VoucherLimitError'
  }
}

type OrderCounter = {
  order: {
    aggregate(args: {
      where: Prisma.OrderWhereInput
      _sum: { providerAmount: true }
    }): Promise<{ _sum: { providerAmount: Prisma.Decimal | number | null } }>
  }
}

export function normaliseEmail(email: string | null | undefined): string | null {
  const e = email?.trim().toLowerCase()
  return e ? e : null
}

/**
 * Throws VoucherLimitError when `amountNgn` on top of today's vouchers for this buyer
 * email or card would pass the daily cap. `excludePaymentIntentId` keeps the order being
 * fulfilled out of its own total.
 */
export async function assertVoucherDailyLimit(
  prisma: OrderCounter,
  input: {
    amountNgn: number
    buyerEmail?: string | null
    cardFingerprint?: string | null
    excludePaymentIntentId?: string
    now?: Date
  },
): Promise<void> {
  const keys: Prisma.OrderWhereInput[] = []
  const email = normaliseEmail(input.buyerEmail)
  if (email) keys.push({ buyerEmail: email })
  if (input.cardFingerprint) keys.push({ cardFingerprint: input.cardFingerprint })
  if (keys.length === 0) return

  const since = new Date((input.now ?? new Date()).getTime() - WINDOW_MS)
  const { _sum } = await prisma.order.aggregate({
    where: {
      productType: 'VOUCHER',
      status: { in: ['PAID', 'FULFILLED'] },
      createdAt: { gte: since },
      OR: keys,
      ...(input.excludePaymentIntentId ? { NOT: { paymentIntentId: input.excludePaymentIntentId } } : {}),
    },
    _sum: { providerAmount: true },
  })

  const already = Number(_sum.providerAmount ?? 0)
  if (already + input.amountNgn > VOUCHER_DAILY_MAX_NGN) {
    const left = Math.max(0, VOUCHER_DAILY_MAX_NGN - already)
    throw new VoucherLimitError(
      left > 0
        ? `Gift vouchers are limited to NGN ${VOUCHER_DAILY_MAX_NGN.toLocaleString('en')} a day. ` +
            `You can buy up to NGN ${left.toLocaleString('en')} more today.`
        : `You've reached today's gift voucher limit of NGN ${VOUCHER_DAILY_MAX_NGN.toLocaleString('en')}. ` +
            'Please try again tomorrow.',
    )
  }
}
