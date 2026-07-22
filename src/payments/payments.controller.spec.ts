import { BadRequestException, InternalServerErrorException, ServiceUnavailableException } from '@nestjs/common'
import { PaymentsController } from './payments.controller'
import { FulfillmentError } from './fulfillment.service'

const PAYMENT_INTENT_ID = 'pi_test_123'

function buildReq(overrides: Partial<Record<string, any>> = {}) {
  return {
    rawBody: Buffer.from('{}'),
    headers: { 'stripe-signature': 'sig_test' },
    ...overrides,
  } as any
}

function buildPiEvent(metadataOverrides: Record<string, string> = {}) {
  return {
    type: 'payment_intent.succeeded',
    data: {
      object: {
        id: PAYMENT_INTENT_ID,
        metadata: { source: 'planettalk-topup', ...metadataOverrides },
      },
    },
  }
}

describe('PaymentsController.webhook', () => {
  let prisma: { order: { updateMany: jest.Mock } }
  let stripe: { constructEvent: jest.Mock }
  let fulfillment: { fulfillByPaymentIntentId: jest.Mock }
  let alert: { notify: jest.Mock }
  let controller: PaymentsController

  beforeEach(() => {
    prisma = { order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    stripe = { constructEvent: jest.fn() }
    fulfillment = { fulfillByPaymentIntentId: jest.fn().mockResolvedValue({ status: 'fulfilled' }) }
    alert = { notify: jest.fn().mockResolvedValue(undefined) }

    controller = new PaymentsController(
      prisma as any,
      stripe as any,
      {} as any, // PricingService — unused by webhook
      {} as any, // SignatureService — unused by webhook
      fulfillment as any,
      alert as any,
    )
  })

  it('fulfills and returns {received:true} for our payment_intent.succeeded events', async () => {
    const event = buildPiEvent()
    stripe.constructEvent.mockReturnValue(event)

    const result = await controller.webhook(buildReq())

    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith(PAYMENT_INTENT_ID)
    expect(result).toEqual({ received: true })
  })

  it('skips fulfillment for events whose metadata.source is not ours', async () => {
    const event = buildPiEvent({ source: 'someone-else' })
    stripe.constructEvent.mockReturnValue(event)

    const result = await controller.webhook(buildReq())

    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
    expect(result).toEqual({ received: true, skipped: true })
  })

  it('skips fulfillment for events with no metadata.source at all', async () => {
    const event = {
      type: 'payment_intent.succeeded',
      data: { object: { id: PAYMENT_INTENT_ID, metadata: {} } },
    }
    stripe.constructEvent.mockReturnValue(event)

    const result = await controller.webhook(buildReq())

    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
    expect(result).toEqual({ received: true, skipped: true })
  })

  it('throws BadRequestException (400) when constructEvent rejects the signature', async () => {
    stripe.constructEvent.mockImplementation(() => {
      throw new Error('bad signature')
    })

    await expect(controller.webhook(buildReq())).rejects.toBeInstanceOf(BadRequestException)
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
  })

  it('rethrows ServiceUnavailableException (503) when webhook secret is missing', async () => {
    stripe.constructEvent.mockImplementation(() => {
      throw new ServiceUnavailableException('STRIPE_WEBHOOK_SECRET is not set')
    })

    await expect(controller.webhook(buildReq())).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
  })

  it('reads the raw body and stripe-signature header from the request when verifying', async () => {
    const event = buildPiEvent()
    stripe.constructEvent.mockReturnValue(event)
    const rawBody = Buffer.from('{"some":"payload"}')

    await controller.webhook(buildReq({ rawBody, headers: { 'stripe-signature': 'sig_abc' } }))

    expect(stripe.constructEvent).toHaveBeenCalledWith(rawBody, 'sig_abc')
  })

  it('returns HTTP 500 (InternalServerErrorException) when fulfillment fails retryably', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
      new FulfillmentError('Reloadly is down', 502, { retryable: true }),
    )
    stripe.constructEvent.mockReturnValue(buildPiEvent())

    await expect(controller.webhook(buildReq())).rejects.toBeInstanceOf(InternalServerErrorException)
    expect(alert.notify).not.toHaveBeenCalled()
  })

  it('returns HTTP 500 when fulfillment fails with a 409 already-in-progress conflict', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(new FulfillmentError('Already processing', 409))
    stripe.constructEvent.mockReturnValue(buildPiEvent())

    await expect(controller.webhook(buildReq())).rejects.toBeInstanceOf(InternalServerErrorException)
  })

  it('acks 200 with fulfillmentFailed and alerts when fulfillment fails non-retryably', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(new FulfillmentError('Amount paid does not cover this order', 402))
    stripe.constructEvent.mockReturnValue(buildPiEvent())

    const result = await controller.webhook(buildReq())

    expect(result).toEqual({ received: true, fulfillmentFailed: true })
    expect(alert.notify).toHaveBeenCalledTimes(1)
    expect(alert.notify.mock.calls[0][0]).toContain(PAYMENT_INTENT_ID)
  })

  it('flags the order as refunded on charge.refunded (via updateMany)', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'charge.refunded',
      data: { object: { payment_intent: PAYMENT_INTENT_ID } },
    })

    const result = await controller.webhook(buildReq())

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentIntentId: PAYMENT_INTENT_ID },
      data: { refunded: true },
    })
    expect(result).toEqual({ received: true })
  })

  it('resolves payment_intent from an expanded object on charge.refunded', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'charge.refunded',
      data: { object: { payment_intent: { id: PAYMENT_INTENT_ID } } },
    })

    await controller.webhook(buildReq())

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentIntentId: PAYMENT_INTENT_ID },
      data: { refunded: true },
    })
  })

  it('does not touch the DB on charge.refunded when payment_intent is missing', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'charge.refunded',
      data: { object: {} },
    })

    const result = await controller.webhook(buildReq())

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(result).toEqual({ received: true })
  })

  it('flags the order as disputed on charge.dispute.created (via updateMany)', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'charge.dispute.created',
      data: { object: { payment_intent: PAYMENT_INTENT_ID } },
    })

    const result = await controller.webhook(buildReq())

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentIntentId: PAYMENT_INTENT_ID },
      data: { disputed: true },
    })
    expect(result).toEqual({ received: true })
  })

  it('acks {received:true} for unhandled event types', async () => {
    stripe.constructEvent.mockReturnValue({ type: 'some.other.event', data: { object: {} } })

    const result = await controller.webhook(buildReq())

    expect(result).toEqual({ received: true })
    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
  })
})

describe('PaymentsController.createIntent', () => {
  let prisma: { order: { create: jest.Mock } }
  let stripe: { hasConfig: jest.Mock; client: { paymentIntents: { create: jest.Mock } } }
  let pricing: { priceOrder: jest.Mock }
  let signature: { sign: jest.Mock }
  let controller: PaymentsController

  const topupOrderDto = {
    productType: 'topup' as const,
    countryCode: 'GB',
    operatorId: 1,
    recipientPhone: '+447700900000',
    providerAmount: 10,
    providerCurrency: 'GBP',
    // useLocalAmount intentionally omitted — this is the case the fix targets.
  }

  beforeEach(() => {
    prisma = { order: { create: jest.fn().mockResolvedValue({}) } }
    stripe = {
      hasConfig: jest.fn().mockReturnValue(true),
      client: {
        paymentIntents: {
          create: jest.fn().mockResolvedValue({ id: 'pi_new_1', client_secret: 'secret_1' }),
        },
      },
    }
    pricing = { priceOrder: jest.fn().mockResolvedValue(13.0) }
    signature = { sign: jest.fn().mockReturnValue('sig_computed') }

    controller = new PaymentsController(
      prisma as any,
      stripe as any,
      pricing as any,
      signature as any,
      {} as any, // FulfillmentService — unused by createIntent
      {} as any, // AlertService — unused by createIntent
    )
  })

  it('normalizes a missing useLocalAmount to true before signing/pricing/metadata for a topup order', async () => {
    await controller.createIntent({ currency: 'gbp', order: { ...topupOrderDto } } as any)

    // The signature must be computed over the *normalized* order (useLocalAmount: true),
    // not the raw undefined value — otherwise the webhook's HMAC recompute (which reads
    // useLocalAmount back from metadata, always coerced to a boolean) mismatches.
    expect(signature.sign).toHaveBeenCalledWith(
      expect.objectContaining({ useLocalAmount: true }),
      '13',
      'GBP',
    )

    // The PaymentIntent metadata written to Stripe must carry the same normalized value.
    const createArgs = stripe.client.paymentIntents.create.mock.calls[0][0]
    expect(createArgs.metadata.useLocalAmount).toBe('true')
  })

  it('leaves an explicit useLocalAmount value untouched', async () => {
    await controller.createIntent({
      currency: 'gbp',
      order: { ...topupOrderDto, useLocalAmount: false },
    } as any)

    expect(signature.sign).toHaveBeenCalledWith(
      expect.objectContaining({ useLocalAmount: false }),
      '13',
      'GBP',
    )
    const createArgs = stripe.client.paymentIntents.create.mock.calls[0][0]
    expect(createArgs.metadata.useLocalAmount).toBe('false')
  })
})
