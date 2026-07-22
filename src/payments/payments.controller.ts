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
  Get,
  HttpException,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Provider as PrismaProvider, ProductType as PrismaProductType } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CreateIntentDto } from './dto/create-intent.dto'
import { buildFulfillmentMetadata, resolveProvider, validateFulfillmentOrder } from './order-metadata'
import { PricingError, PricingService } from './pricing.service'
import { FULFILLMENT_SIG_META, SignatureService } from './signature.service'
import { StripeService } from './stripe.service'
import { toStripeAmount, validateStripeAmount } from './static-fx'
import type { FulfillmentOrder, FulfillmentProductType } from './payments.types'

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
  constructor(
    private readonly prisma: PrismaService,
    private readonly stripe: StripeService,
    private readonly pricing: PricingService,
    private readonly signature: SignatureService,
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
