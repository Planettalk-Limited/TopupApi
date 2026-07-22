// POST create-intent + GET verify — ports TopupApp's
// src/app/api/stripe/create-payment-intent/route.ts onto the DB-backed Order/
// Fulfillment model. Behavior preserved verbatim:
//   - the Stripe charge is always computed server-side from the order via
//     `PricingService.priceOrder` — any client-supplied `amount` is ignored, binding
//     the price paid to the value delivered (see pricing.service.ts header).
//   - the PaymentIntent carries the same fulfillment metadata + HMAC binding
//     signature the frontend route attached, so `FulfillmentService` (task 9's
//     webhook) can verify it wasn't crafted directly against a leaked Stripe key.
//
// New in this backend: on success we also create the authoritative `Order` +
// `Fulfillment(PENDING)` DB rows keyed by the PaymentIntent id, and `verify` reads
// order/fulfillment status back out of the DB instead of re-querying Stripe.
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Post,
  Query,
  Req,
  ServiceUnavailableException,
} from '@nestjs/common'
import type { RawBodyRequest } from '@nestjs/common'
import { SkipThrottle, Throttle } from '@nestjs/throttler'
import { Provider as PrismaProvider, ProductType as PrismaProductType } from '@prisma/client'
import type { Request } from 'express'
import type Stripe from 'stripe'
import { AlertService } from '../common/alert.service'
import { PrismaService } from '../common/prisma.service'
import { CreateIntentDto } from './dto/create-intent.dto'
import { FulfillmentError, FulfillmentService } from './fulfillment.service'
import { buildFulfillmentMetadata, resolveProvider, validateFulfillmentOrder } from './order-metadata'
import { PricingError, PricingService } from './pricing.service'
import { FULFILLMENT_SIG_META, SignatureService } from './signature.service'
import { StripeService } from './stripe.service'
import { toStripeAmount, validateStripeAmount } from './static-fx'
import type { FulfillmentOrder, FulfillmentProductType, TopupFulfillmentOrder } from './payments.types'

// App-wide source flag stamped on every intent we mint (see order-metadata.ts /
// createIntent below). Used by the webhook to ignore intents that did not
// originate from this app — mirrors TopupApp's
// src/app/api/stripe/webhook/route.ts APP_SOURCE constant.
const APP_SOURCE = 'planettalk-topup'

function mapProductType(productType: FulfillmentProductType): PrismaProductType {
  switch (productType) {
    case 'topup':
      return PrismaProductType.TOPUP
    case 'data':
      return PrismaProductType.DATA
    case 'giftcard':
      return PrismaProductType.GIFTCARD
    case 'utility':
      return PrismaProductType.UTILITY
  }
}

@Controller('payments')
export class PaymentsController {
  private readonly logger = new Logger(PaymentsController.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly pricing: PricingService,
    private readonly signature: SignatureService,
    private readonly fulfillment: FulfillmentService,
    private readonly alert: AlertService,
  ) {}

  // Matches the frontend route's rate limit (15 requests / 60s per caller).
  @Throttle({ default: { limit: 15, ttl: 60_000 } })
  @Post('create-intent')
  async createIntent(@Body() dto: CreateIntentDto) {
    if (!this.stripe.hasConfig()) {
      throw new ServiceUnavailableException('Payment service is not configured. Please contact support.')
    }

    const currency = (dto.currency || 'usd').toLowerCase()
    // NOTE: any client-supplied `amount` is intentionally not accepted anywhere in
    // this DTO. The charge is computed server-side from the order below so it can
    // never be lower than the value delivered to the provider.
    const order = dto.order as unknown as FulfillmentOrder

    const orderError = validateFulfillmentOrder(order)
    if (orderError) {
      throw new BadRequestException(orderError)
    }

    // Normalize once, up front, before pricing/signing/metadata all read this field.
    // If a topup/data order omits `useLocalAmount`, `canonicalize` would sign it as ''
    // but `parseFulfillmentOrder` later coerces the empty metadata value back to `true`
    // — an HMAC mismatch on the webhook's recompute (403 charged-not-delivered). Pricing
    // and the executor already default to `?? true`, so making it explicit here changes
    // no behavior for well-formed orders; it just makes the signed value match reality.
    if (order.productType === 'topup' || order.productType === 'data') {
      ;(order as TopupFulfillmentOrder).useLocalAmount = (order as TopupFulfillmentOrder).useLocalAmount ?? true
    }

    // Server computes the authoritative charge from the order + the provider's real
    // product data (validating limits and denominations). See pricing.service.ts.
    let chargeAmount: number
    try {
      chargeAmount = await this.pricing.priceOrder(order, currency)
    } catch (error) {
      if (error instanceof PricingError) {
        throw new HttpException(error.message, error.statusCode)
      }
      throw error
    }

    const validation = validateStripeAmount(chargeAmount, currency)
    if (!validation.valid) {
      throw new BadRequestException(validation.error)
    }

    const chargeAmountStr = String(chargeAmount)
    const chargeCurrencyStr = currency.toUpperCase()
    const fulfillmentMetadata = buildFulfillmentMetadata(order)

    // Bind this intent to our route: only intents we minted carry a valid signature, so
    // an intent crafted directly via the Stripe API (e.g. with a leaked key) cannot be
    // fulfilled.
    const fulfillmentSig = this.signature.sign(order, chargeAmountStr, chargeCurrencyStr)

    const paymentIntent = await this.stripe.client.paymentIntents.create({
      amount: toStripeAmount(chargeAmount, currency),
      currency,
      automatic_payment_methods: {
        enabled: true,
      },
      metadata: {
        ...fulfillmentMetadata,
        chargeAmount: chargeAmountStr,
        chargeCurrency: chargeCurrencyStr,
        [FULFILLMENT_SIG_META]: fulfillmentSig,
      },
    })

    await this.createOrderRow(paymentIntent.id, order, chargeAmount, chargeCurrencyStr)

    return {
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id,
      // Authoritative amount the customer will be charged. The client should display this.
      amount: chargeAmount,
      currency: chargeCurrencyStr,
    }
  }

  @Get('verify')
  async verify(@Query('paymentIntentId') paymentIntentId: string) {
    if (!paymentIntentId?.trim()) {
      throw new BadRequestException('paymentIntentId is required')
    }

    const order = await this.prisma.order.findUnique({
      where: { paymentIntentId },
      include: { fulfillment: true },
    })

    if (!order) {
      throw new NotFoundException('Order not found')
    }

    return {
      orderStatus: order.status,
      fulfillmentStatus: order.fulfillment?.status ?? null,
      providerTransactionId: order.fulfillment?.providerTransactionId ?? null,
      error: order.fulfillment?.lastError ?? null,
    }
  }

  // Mirrors the frontend's ownership guard (TopupApp's
  // verifyPaymentIntentOwnership / redeem-code route): the caller must supply
  // BOTH the paymentIntentId AND the providerTransactionId that fulfilment
  // produced. Knowing only the paymentIntentId (e.g. guessed/enumerated) is
  // not enough — the providerTransactionId is only known to a client that
  // already went through (or was returned) a successful fulfilment, so this
  // is not guessable/brute-forceable in practice.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @Get('gift-card-code')
  async getGiftCardCode(
    @Query('paymentIntentId') paymentIntentId: string,
    @Query('providerTransactionId') providerTransactionId: string,
  ) {
    if (!paymentIntentId?.trim() || !providerTransactionId?.trim()) {
      throw new BadRequestException('paymentIntentId and providerTransactionId are required')
    }

    const order = await this.prisma.order.findUnique({
      where: { paymentIntentId },
      include: { fulfillment: true },
    })

    if (!order) {
      throw new NotFoundException('Order not found')
    }

    const fulfillment = order.fulfillment
    // SECURITY: a refunded/charged-back order must not still surface the redeemable
    // code — value delivery is being reversed/disputed, so allowing another fetch
    // here would let the customer double-dip (redeem the code AND keep the refund).
    const owns =
      fulfillment?.status === 'FULFILLED' &&
      !!fulfillment.providerTransactionId &&
      fulfillment.providerTransactionId === providerTransactionId &&
      !order.refunded &&
      !order.disputed

    if (!owns) {
      throw new ForbiddenException('Unauthorized to access this gift card code')
    }

    const meta = (fulfillment.meta ?? {}) as Record<string, unknown>
    const cardCode = typeof meta.cardCode === 'string' ? meta.cardCode : null

    if (!cardCode) {
      throw new NotFoundException('Gift card code not available')
    }

    return {
      cardCode,
      ...(typeof meta.cardPin === 'string' ? { cardPin: meta.cardPin } : {}),
      ...(typeof meta.redemptionUrl === 'string' ? { redemptionUrl: meta.redemptionUrl } : {}),
    }
  }

  // Ports TopupApp's src/app/api/stripe/webhook/route.ts onto FulfillmentService.
  // Requires `NestFactory.create(AppModule, { rawBody: true })` in main.ts so
  // `req.rawBody` is the untouched request body Stripe signed (JSON.parse'd body
  // would fail signature verification).
  @SkipThrottle()
  @Post('webhook')
  async webhook(@Req() req: RawBodyRequest<Request>) {
    const signature = req.headers['stripe-signature'] as string | undefined

    let event: Stripe.Event
    try {
      event = this.stripe.constructEvent(req.rawBody as Buffer, signature as string)
    } catch (error) {
      if (error instanceof ServiceUnavailableException) throw error
      throw new BadRequestException('Invalid webhook signature')
    }

    switch (event.type) {
      case 'payment_intent.succeeded':
        return this.handlePaymentIntentSucceeded(event.data.object as Stripe.PaymentIntent)
      case 'charge.refunded':
        return this.handleChargeRefunded(event.data.object as Stripe.Charge)
      case 'charge.dispute.created':
        return this.handleDisputeCreated(event.data.object as Stripe.Dispute)
      default:
        return { received: true }
    }
  }

  /**
   * Authoritative fulfillment trigger — the reliable server-to-server path that
   * fulfills the order even if the customer's browser closed before the client-side
   * fallback ran. Status codes are chosen so Stripe's built-in retry works FOR us:
   *  - retryable failure (provider 5xx / network / 409 already-claimed-elsewhere) ->
   *    500 so Stripe redelivers with backoff (fulfillByPaymentIntentId is idempotent,
   *    so redelivery is safe).
   *  - non-retryable refusal (bad order, price/origin check) -> 200; retrying can
   *    never help, so don't make Stripe hammer us — alert a human instead.
   */
  private async handlePaymentIntentSucceeded(paymentIntent: Stripe.PaymentIntent) {
    if (paymentIntent.metadata?.source !== APP_SOURCE) {
      return { received: true, skipped: true }
    }

    try {
      await this.fulfillment.fulfillByPaymentIntentId(paymentIntent.id)
      return { received: true }
    } catch (error) {
      const retryable =
        error instanceof FulfillmentError && (error.statusCode === 409 || error.retryable === true)

      const message = error instanceof Error ? error.message : String(error)

      if (retryable) {
        this.logger.warn(`Retryable fulfillment failure for ${paymentIntent.id}: ${message}`)
        throw new InternalServerErrorException('Fulfillment failed, will retry')
      }

      this.logger.error(`Fulfillment permanently failed for ${paymentIntent.id}: ${message}`)
      await this.alert.notify(
        `Fulfillment permanently failed for ${paymentIntent.id}: ${message}. ` +
          `Customer paid but order was not delivered — manual retry required.`,
        'critical',
      )
      return { received: true, fulfillmentFailed: true }
    }
  }

  /**
   * A refund was issued. Flag the order so reconciliation/admin tooling can see it —
   * value may already have been delivered to the provider. `updateMany` (not `update`)
   * so a payment intent we don't have an order row for doesn't throw.
   */
  private async handleChargeRefunded(charge: Stripe.Charge) {
    const paymentIntentId =
      typeof charge.payment_intent === 'string' ? charge.payment_intent : charge.payment_intent?.id

    if (paymentIntentId) {
      await this.prisma.order.updateMany({
        where: { paymentIntentId },
        data: { refunded: true },
      })
    }

    return { received: true }
  }

  /**
   * A chargeback was opened — the highest-risk fraud signal, since value may already
   * be delivered and is now at risk. Flag the order for reconciliation/admin tooling.
   */
  private async handleDisputeCreated(dispute: Stripe.Dispute) {
    const paymentIntentId =
      typeof dispute.payment_intent === 'string' ? dispute.payment_intent : dispute.payment_intent?.id

    if (paymentIntentId) {
      await this.prisma.order.updateMany({
        where: { paymentIntentId },
        data: { disputed: true },
      })
    }

    return { received: true }
  }

  private async createOrderRow(
    paymentIntentId: string,
    order: FulfillmentOrder,
    chargeAmount: number,
    chargeCurrency: string,
  ): Promise<void> {
    const provider = resolveProvider(order.countryCode, order.productType).toUpperCase() as PrismaProvider

    const data: Record<string, unknown> = {
      paymentIntentId,
      productType: mapProductType(order.productType),
      provider,
      countryCode: order.countryCode.toUpperCase(),
      productName: order.productName,
      providerAmount: order.providerAmount,
      providerCurrency: order.providerCurrency.toUpperCase(),
      chargeAmount,
      chargeCurrency,
      status: 'CREATED',
      fulfillment: { create: { status: 'PENDING' } },
    }

    switch (order.productType) {
      case 'topup':
      case 'data':
        data.operatorId = String(order.operatorId)
        data.recipientPhone = order.recipientPhone
        break
      case 'giftcard':
        data.productId = String(order.productId)
        data.recipientEmail = order.recipientEmail
        break
      case 'utility':
        data.billerId = String(order.billerId)
        data.accountNumber = order.accountNumber
        break
    }

    await this.prisma.order.create({ data: data as never })
  }
}
