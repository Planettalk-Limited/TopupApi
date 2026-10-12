import type { Prisma } from '@prisma/client'

export class PromoRedemptionLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PromoRedemptionLimitError'
  }
}

export interface PromoRedemptionParams {
  promoCodeId: string
  customerId: string
  orderId: string
  discountAmount: number
  currency: string
}

/**
 * Record that an order used a promo code. Called inside the transaction that moves the
 * order CREATED -> PAID (FulfillmentService), so it runs exactly once per order: a
 * webhook replay matches 0 rows on that transition and never gets here, and
 * PromoRedemption.orderId is UNIQUE as a backstop.
 *
 * The promo row is locked (SELECT … FOR UPDATE) and the limits re-counted, so two orders
 * paid concurrently cannot both squeeze under a per-customer or global cap that
 * create-intent checked separately for each. Throws PromoRedemptionLimitError when the
 * cap has been reached in the meantime — the caller rolls the PAID transition back and
 * releases the hold rather than deliver at a discount the code no longer allows.
 */
export async function recordPromoRedemption(
  tx: Prisma.TransactionClient,
  params: PromoRedemptionParams,
): Promise<void> {
  await tx.$queryRaw`SELECT id FROM promo_codes WHERE id = ${params.promoCodeId} FOR UPDATE`
  const promo = await tx.promoCode.findUnique({ where: { id: params.promoCodeId } })
  if (!promo) {
    throw new PromoRedemptionLimitError('Promo code no longer exists')
  }

  const [total, mine] = await Promise.all([
    promo.maxRedemptions !== null ? tx.promoRedemption.count({ where: { promoCodeId: promo.id } }) : 0,
    tx.promoRedemption.count({ where: { promoCodeId: promo.id, customerId: params.customerId } }),
  ])
  if (promo.maxRedemptions !== null && total >= promo.maxRedemptions) {
    throw new PromoRedemptionLimitError(`Promo ${promo.code} reached its redemption cap`)
  }
  if (mine >= promo.perCustomerLimit) {
    throw new PromoRedemptionLimitError(`Promo ${promo.code} already used by this customer`)
  }

  await tx.promoRedemption.create({ data: params })
}
