// Fulfilment orchestrator — the safety-critical unit that stands between a
// succeeded Stripe PaymentIntent and provider value being released.
//
// Preserves the frontend's security model (TopupApp/src/lib/fulfillment/fulfill-payment-intent.ts)
// verbatim:
//   1. assertPaidEnough — re-price the order from scratch (never trust intent metadata) and
//      require amount_received to cover the authoritative charge.
//   2. assertOriginatedByUs — reject intents that don't carry a valid HMAC binding signature
//      (when a signing secret is configured); a missing signature is allowed through
//      (pre-migration intent) since assertPaidEnough already protects value.
//
// On top of that, this backend adds a real double-fulfilment lock: the DB-backed
// `Fulfillment` row is claimed with `SELECT ... FOR UPDATE` inside a single interactive
// transaction, so only one caller can ever move a row out of PENDING and execute the
// provider call, unlike the frontend's best-effort Stripe-metadata TOCTOU guard.
import { Injectable, Logger } from '@nestjs/common'
import type Stripe from 'stripe'
import { PrismaService } from '../common/prisma.service'
import { StripeService } from './stripe.service'
import { PricingService, PricingError } from './pricing.service'
import { SignatureService, FULFILLMENT_SIG_META } from './signature.service'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { parseFulfillmentOrder } from './order-metadata'
import { toStripeAmount } from './static-fx'
import type { FulfillmentOrder, TopupFulfillmentOrder } from './payments.types'

export type FulfillmentOutcome = {
  status: 'fulfilled' | 'already' | 'skipped'
  retryable?: boolean
}

export class FulfillmentError extends Error {
  statusCode: number
  retryable?: boolean

  constructor(message: string, statusCode = 400, options?: { retryable?: boolean }) {
    super(message)
    this.name = 'FulfillmentError'
    this.statusCode = statusCode
    this.retryable = options?.retryable
  }
}

@Injectable()
export class FulfillmentService {
  private readonly logger = new Logger(FulfillmentService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly pricing: PricingService,
    private readonly signature: SignatureService,
    private readonly executor: ReloadlyTopupExecutor
  ) {}

  async fulfillByPaymentIntentId(paymentIntentId: string): Promise<FulfillmentOutcome> {
    const orderRow = await this.prisma.order.findUnique({
      where: { paymentIntentId },
      include: { fulfillment: true },
    })
    if (!orderRow) {
      throw new FulfillmentError('Order not found', 404)
    }

    const pi = await this.stripe.client.paymentIntents.retrieve(paymentIntentId)
    if (pi.status !== 'succeeded') {
      throw new FulfillmentError('Payment has not succeeded', 402)
    }

    const metadata = (pi.metadata || {}) as Record<string, string>
    const order = parseFulfillmentOrder(metadata)

    // SECURITY (primary control): re-price from scratch and require amount_received to
    // cover it. Never trust any amount carried in intent metadata.
    await this.assertPaidEnough(pi, order)

    // SECURITY (origin lockdown): reject intents not minted by our own checkout route.
    this.assertOriginatedByUs(pi, metadata, order)

    if (order.productType !== 'topup' && order.productType !== 'data') {
      throw new FulfillmentError('Unsupported in SP-2 slice', 501)
    }
    const topupOrder = order as TopupFulfillmentOrder

    await this.prisma.order.update({
      where: { id: orderRow.id },
      data: { status: 'PAID' },
    })

    const orderId = orderRow.id

    return await this.prisma.$transaction(async (tx: any) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM fulfillments WHERE "orderId" = ${orderId} FOR UPDATE`
      const f = rows[0]
      if (!f || f.status !== 'PENDING') {
        return { status: 'already' as const }
      }

      await tx.fulfillment.update({
        where: { orderId },
        data: { status: 'PROCESSING', processingClaimedAt: new Date() },
      })

      try {
        const txn = await this.executor.execute(topupOrder, paymentIntentId)

        await tx.fulfillment.update({
          where: { orderId },
          data: {
            status: 'FULFILLED',
            providerTransactionId: String(txn.transactionId),
            fulfilledAt: new Date(),
          },
        })
        await tx.order.update({ where: { id: orderId }, data: { status: 'FULFILLED' } })
        await tx.providerCallLog.create({
          data: {
            orderId,
            provider: 'RELOADLY',
            endpoint: '/topups',
            method: 'POST',
            success: true,
            responseStatus: 200,
          },
        })

        return { status: 'fulfilled' as const }
      } catch (err) {
        const retryable = (err as any)?.retryable === true
        const message = String((err as any)?.message ?? err)

        await tx.fulfillment.update({
          where: { orderId },
          data: {
            status: 'FAILED',
            lastError: message.slice(0, 500),
            attempts: { increment: 1 },
          },
        })
        await tx.providerCallLog.create({
          data: {
            orderId,
            provider: 'RELOADLY',
            endpoint: '/topups',
            method: 'POST',
            success: false,
            error: message.slice(0, 300),
            responseStatus: (err as any)?.statusCode ?? null,
          },
        })

        throw new FulfillmentError(message || 'Fulfillment failed', (err as any)?.statusCode ?? 500, {
          retryable,
        })
      }
    })
  }

  /**
   * Re-derive the authoritative charge for this order and refuse fulfillment unless the
   * amount actually received covers it. See file header / frontend source for the full
   * security rationale — logic preserved verbatim.
   */
  private async assertPaidEnough(paymentIntent: Stripe.PaymentIntent, order: FulfillmentOrder): Promise<void> {
    const currency = paymentIntent.currency

    let authoritative: number
    try {
      authoritative = await this.pricing.priceOrder(order, currency)
    } catch (error) {
      if (error instanceof PricingError) {
        throw new FulfillmentError(error.message, error.statusCode)
      }
      throw new FulfillmentError(
        error instanceof Error ? error.message : 'Unable to validate order price',
        502,
        { retryable: true }
      )
    }

    const expected = toStripeAmount(authoritative, currency)
    if (paymentIntent.amount_received < expected) {
      throw new FulfillmentError('Amount paid does not cover this order', 402)
    }
  }

  /**
   * Reject intents that did not come through our checkout. A present-but-invalid signature
   * is a hard refusal; a missing signature is allowed through (pre-migration intent) since
   * value is still protected by `assertPaidEnough`. Logic preserved verbatim from the frontend.
   */
  private assertOriginatedByUs(
    paymentIntent: Stripe.PaymentIntent,
    metadata: Record<string, string>,
    order: FulfillmentOrder
  ): void {
    if (!this.signature.hasSecret()) return

    const sig = metadata[FULFILLMENT_SIG_META]
    if (!sig) {
      this.logger.warn(
        `No binding signature on intent ${paymentIntent.id}; allowing on price check (pre-migration intent).`
      )
      return
    }

    const ok = this.signature.verify(order, metadata.chargeAmount, metadata.chargeCurrency, sig)
    if (!ok) {
      throw new FulfillmentError('This payment was not initiated through our checkout', 403)
    }
  }
}
