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
// `Fulfillment` row is claimed with `SELECT ... FOR UPDATE` inside a short, DB-only
// transaction, so only one caller can ever move a row out of PENDING. That claim is
// committed durably BEFORE the outbound provider HTTP call runs — the call and the
// result writes execute outside any transaction, so a rollback (executor throw, a
// post-success write failure, or Prisma's interactive-tx timeout) can never revert an
// already-claimed row back to PENDING and trigger a duplicate real top-up. See
// three-phase structure below: claim / execute / record.
import { Injectable, Logger } from '@nestjs/common'
import type Stripe from 'stripe'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CustomerEmailService } from '../common/customer-email.service'
import { GaMeasurementProtocolService } from '../common/ga-measurement-protocol.service'
import type { AnalyticsVertical } from '../common/ga-measurement-protocol.service'
import { StripeService } from './stripe.service'
import { PricingService, PricingError } from './pricing.service'
import { SignatureService, FULFILLMENT_SIG_META } from './signature.service'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { ReloadlyGiftCardExecutor } from './executors/reloadly-gift-card.executor'
import { ReloadlyPayBillExecutor } from './executors/reloadly-pay-bill.executor'
import { PlanetTalkTopupExecutor } from './executors/planettalk-topup.executor'
import { PlanetTalkPayBillExecutor } from './executors/planettalk-pay-bill.executor'
import { parseFulfillmentOrder, resolveProvider } from './order-metadata'
import { toStripeAmount, fromStripeAmount } from './static-fx'
import type {
  FulfillmentOrder,
  FulfillmentTransaction,
  GiftCardFulfillmentOrder,
  TopupFulfillmentOrder,
  UtilityFulfillmentOrder,
} from './payments.types'

export type FulfillmentOutcome = {
  status: 'fulfilled' | 'already' | 'skipped'
  retryable?: boolean
}

/**
 * Map the stored product type onto the analytics taxonomy shared with the browser, so a
 * funnel can be read end to end without translating names in GA4. DATA rolls up with
 * TOPUP: both are mobile credit to the customer, and splitting them would fragment the
 * vertical without adding insight.
 */
function toAnalyticsVertical(productType: string): AnalyticsVertical {
  switch (productType) {
    case 'GIFTCARD':
      return 'gift_card'
    case 'UTILITY':
      return 'utility_bill'
    default:
      return 'mobile_topup'
  }
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
    private readonly executor: ReloadlyTopupExecutor,
    private readonly giftCardExecutor: ReloadlyGiftCardExecutor,
    private readonly payBillExecutor: ReloadlyPayBillExecutor,
    private readonly planetTalkTopupExecutor: PlanetTalkTopupExecutor,
    private readonly planetTalkPayBillExecutor: PlanetTalkPayBillExecutor,
    private readonly customerEmail: CustomerEmailService,
    private readonly ga: GaMeasurementProtocolService
  ) {}

  /**
   * Narrow the stored `gaSessions` JSON column back to a string map. The column is
   * sanitized on write, but Prisma types it as arbitrary JSON and legacy rows predate
   * the field entirely — anything unexpected degrades to null rather than throwing on
   * the fulfilment path.
   */
  private parseGaSessions(value: Prisma.JsonValue | null | undefined): Record<string, string> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null

    const sessions: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'string') sessions[key] = entry
    }

    return Object.keys(sessions).length > 0 ? sessions : null
  }

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

    // Provider resolution mirrors the frontend/metadata: RELOADLY unless the order is a
    // Nigerian topup/data or utility with TOPUP_PROVIDER_NG=planettalk (gift cards always
    // stay on Reloadly — resolveProvider hard-codes that). Both providers are fully
    // supported for topup/data and utility now; gift cards remain Reloadly-only.
    const provider = resolveProvider(order.countryCode, order.productType)
    const isSupported =
      order.productType === 'topup' ||
      order.productType === 'data' ||
      order.productType === 'giftcard' ||
      order.productType === 'utility'

    if (!isSupported) {
      throw new FulfillmentError('Unsupported in SP-2 slice', 501)
    }

    // Endpoint each product type's executor calls — used for ProviderCallLog only.
    const providerCallLogProvider = provider === 'planettalk' ? 'PLANETTALK' : 'RELOADLY'
    const endpoint =
      provider === 'planettalk'
        ? '/products/purchase'
        : order.productType === 'giftcard'
          ? '/orders'
          : order.productType === 'utility'
            ? '/pay'
            : '/topups'

    // Guarded transition: only promote CREATED -> PAID, never downgrade a terminal
    // order. A replayed webhook on an already-FULFILLED order (or a redelivery once
    // the order is already PAID) matches 0 rows here and is a no-op — the later
    // success write is what still advances the order to FULFILLED.
    const paidTransition = await this.prisma.order.updateMany({
      where: { id: orderRow.id, status: 'CREATED' },
      data: { status: 'PAID' },
    })

    // ANALYTICS (non-critical). This guarded update is the one place in the system where
    // an order becomes PAID, and `count` is 1 for exactly the caller that performed the
    // transition — every webhook replay or concurrent redelivery matches 0 rows. That
    // makes it the natural exactly-once hook for revenue reporting, with no dependence
    // on GA4's own transaction_id de-duplication.
    //
    // Deliberately NOT awaited: the send has its own 3s timeout and can never throw, but
    // waiting on it would delay the provider call that actually delivers value to the
    // customer. A lost event on process restart is an acceptable trade; a delayed top-up
    // is not.
    if (paidTransition.count === 1) {
      // try/catch AND .catch(): `void` still evaluates synchronously, so a synchronous
      // throw here would propagate into the fulfilment path — same defensive shape as
      // the customer-email call site below.
      try {
        Promise.resolve(
          this.ga.sendPurchase({
            transactionId: orderRow.id,
            value: Number(orderRow.chargeAmount),
            currency: orderRow.chargeCurrency,
            clientId: orderRow.gaClientId ?? null,
            sessions: this.parseGaSessions(orderRow.gaSessions),
            vertical: toAnalyticsVertical(orderRow.productType),
            countryCode: orderRow.countryCode,
            provider: orderRow.provider,
            productName: orderRow.productName,
          }),
        ).catch((err) => this.logger.error('GA4 purchase report failed', err as Error))
      } catch (err) {
        this.logger.error('GA4 purchase report threw synchronously', err as Error)
      }
    }

    const orderId = orderRow.id

    // --- Phase 1: claim. Short, DB-only transaction — no network I/O inside it.
    // Commits the PROCESSING claim durably before the provider call runs, so a later
    // rollback (from the executor, from a Phase-3 write, or from the tx timeout) can
    // never unwind this claim back to PENDING. Concurrent callers/replays block on the
    // row lock, then see a non-PENDING status and return 'already' without ever
    // invoking the executor twice.
    const claimed = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const rows = await tx.$queryRaw<Array<{ id: string; status: string }>>`
        SELECT id, status FROM fulfillments WHERE "orderId" = ${orderId} FOR UPDATE`
      const f = rows[0]
      // Re-claim FAILED rows too: on a retryable executor failure the row moved to
      // FAILED and the webhook returned a 5xx so Stripe redelivers. If redelivery only
      // matched PENDING, a FAILED row would no-op forever, permanently stranding a PAID
      // order. PROCESSING/FULFILLED are still terminal-for-claiming here — those mean
      // another caller is mid-flight or already succeeded.
      if (!f || (f.status !== 'PENDING' && f.status !== 'FAILED')) {
        return false
      }

      await tx.fulfillment.update({
        where: { orderId },
        data: { status: 'PROCESSING', processingClaimedAt: new Date() },
      })
      return true
    })

    if (!claimed) {
      return { status: 'already' as const }
    }

    // --- Phase 2: execute. Deliberately OUTSIDE any transaction — no DB row lock or
    // pooled connection is held across the outbound provider HTTP call.
    let txn: FulfillmentTransaction
    // Provider extras that don't fit a fixed column (gift-card code/pin, or a utility
    // biller's returned token/units — including PlanetTalk electricity's token/units),
    // persisted into Fulfillment.meta on success.
    let meta: Prisma.InputJsonValue | undefined
    try {
      if (order.productType === 'giftcard') {
        // Gift cards are always Reloadly (resolveProvider hard-codes this).
        const result = await this.giftCardExecutor.execute(order as GiftCardFulfillmentOrder, paymentIntentId)
        txn = result.transaction
        if (result.giftCard) {
          meta = {
            cardCode: result.giftCard.cardCode,
            ...(result.giftCard.cardPin ? { cardPin: result.giftCard.cardPin } : {}),
            ...(result.giftCard.redemptionUrl ? { redemptionUrl: result.giftCard.redemptionUrl } : {}),
            ...(result.giftCard.isSandboxTest ? { isSandboxTest: true } : {}),
          }
        }
      } else if (order.productType === 'utility') {
        txn =
          provider === 'planettalk'
            ? await this.planetTalkPayBillExecutor.execute(order as UtilityFulfillmentOrder, paymentIntentId)
            : await this.payBillExecutor.execute(order as UtilityFulfillmentOrder, paymentIntentId)
      } else {
        txn =
          provider === 'planettalk'
            ? await this.planetTalkTopupExecutor.execute(order as TopupFulfillmentOrder, paymentIntentId)
            : await this.executor.execute(order as TopupFulfillmentOrder, paymentIntentId)
      }
      // Persist any provider-returned meta (e.g. a utility biller's token/units, or a
      // topup/data executor's generically-captured meta — such as PlanetTalk electricity
      // details returned via the topup path) uniformly for every non-giftcard product
      // type. Gift cards populate `meta` above from their card-code result instead.
      if (order.productType !== 'giftcard' && txn.meta) {
        meta = txn.meta as Prisma.InputJsonValue
      }
    } catch (err) {
      // Phase 3a: failure. Separate, non-transactional writes so this telemetry
      // persists even though the attempt failed — it must never be rolled back.
      const retryable = (err as any)?.retryable === true
      const message = String((err as any)?.message ?? err)

      await this.prisma.fulfillment.update({
        where: { orderId },
        data: {
          status: 'FAILED',
          lastError: message.slice(0, 500),
          attempts: { increment: 1 },
        },
      })
      await this.prisma.providerCallLog.create({
        data: {
          orderId,
          provider: providerCallLogProvider,
          endpoint,
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

    // --- Phase 3b: success. Separate, non-transactional writes.
    // CRITICAL invariant: the executor has already moved real value. If any write below
    // throws, we do NOT revert the row to PENDING and do NOT re-run the executor — the
    // error just propagates and the row stays PROCESSING (safe: a replay sees PROCESSING
    // and returns 'already'; a stale PROCESSING row is recoverable by an out-of-band
    // reconciliation job, never by re-executing).
    await this.prisma.fulfillment.update({
      where: { orderId },
      data: {
        status: 'FULFILLED',
        providerTransactionId: String(txn.transactionId),
        fulfilledAt: new Date(),
        ...(meta ? { meta } : {}),
      },
    })
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'FULFILLED' } })
    await this.prisma.providerCallLog.create({
      data: {
        orderId,
        provider: providerCallLogProvider,
        endpoint,
        method: 'POST',
        success: true,
        responseStatus: 200,
      },
    })

    // OUR customer-facing confirmation (client requirement: sent from PlanetTalk,
    // websales@planettalk.com, do-not-reply, support routed to care@planettalk.com).
    // Note: buhibab (PlanetTalk/Nigeria provider) also sends its own Buhibab-branded
    // receipt, because the buyer's address is forwarded as its mandatory `email` field
    // (planettalk-*.executor.ts). Deliberately NOT suppressed on our side — buhibab is
    // being asked to disable merchant confirmation emails on the account instead, so
    // the customer is left with this PlanetTalk-branded one only.
    // Fire-and-forget: CustomerEmailService never throws, but `.catch()` defensively
    // anyway so a mail failure can never affect fulfilment's return value or DB state.
    const buyerEmail = order.email || (order.productType === 'giftcard' ? order.recipientEmail : undefined)
    if (buyerEmail) {
      try {
        Promise.resolve(
          this.customerEmail.sendPurchaseConfirmation({
            to: buyerEmail,
            productName: order.productName,
            amount: fromStripeAmount(pi.amount_received, pi.currency),
            currency: pi.currency.toUpperCase(),
            recipient:
              order.productType === 'topup' || order.productType === 'data'
                ? order.recipientPhone
                : order.productType === 'utility'
                  ? order.accountNumber
                  : order.productType === 'giftcard'
                    ? order.recipientEmail
                    : undefined,
            // Prefer the provider's traceable reference (buhibab `data.reference`,
            // Reloadly `referenceId`) over `transactionId`, which for buhibab is an
            // internal row counter (e.g. "16") that its support cannot look up — the
            // body tells the customer to quote this to care@planettalk.com.
            reference: String(txn.referenceId ?? txn.transactionId ?? paymentIntentId),
            token: (meta as Record<string, unknown> | undefined)?.token as string | undefined,
            units: (meta as Record<string, unknown> | undefined)?.units as string | number | undefined,
          })
        ).catch((err) => this.logger.error('Customer confirmation email dispatch failed', err as Error))
      } catch (err) {
        this.logger.error('Customer confirmation email dispatch threw synchronously', err as Error)
      }
    }

    return { status: 'fulfilled' as const }
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
