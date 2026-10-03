import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { PaymentsController } from './payments.controller'
import { FulfillmentError } from './fulfillment.service'
import { SignatureService } from './signature.service'

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
      {} as any, // HealthcareService — unused
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
    // A real GB mobile range: create-intent now rejects invalid numbers before charging,
    // and 07700 900xxx is Ofcom's reserved drama range (no such subscriber exists).
    recipientPhone: '+447860980321',
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
      {} as any, // HealthcareService — unused
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

describe('PaymentsController.verify', () => {
  let prisma: { order: { findUnique: jest.Mock } }
  let controller: PaymentsController

  function buildController() {
    return new PaymentsController(
      prisma as any,
      {} as any, // StripeService — unused
      {} as any, // PricingService — unused
      {} as any, // SignatureService — unused
      {} as any, // FulfillmentService — unused
      {} as any, // AlertService — unused
      {} as any, // HealthcareService — unused
    )
  }

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn() } }
    controller = buildController()
  })

  it('returns orderStatus/fulfillmentStatus plus a mapped transaction object for a fulfilled order', async () => {
    prisma.order.findUnique.mockResolvedValue({
      status: 'FULFILLED',
      provider: 'RELOADLY',
      providerAmount: '13.00',
      providerCurrency: 'GBP',
      productName: 'Vodafone 10 GBP Topup',
      recipientPhone: '+447700900123',
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: 'txn_abc_123',
        lastError: null,
      },
    })

    const result = await controller.verify(PAYMENT_INTENT_ID)

    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { paymentIntentId: PAYMENT_INTENT_ID },
      include: { fulfillment: true },
    })
    expect(result).toEqual({
      orderStatus: 'FULFILLED',
      fulfillmentStatus: 'FULFILLED',
      providerTransactionId: 'txn_abc_123',
      error: null,
      transaction: {
        transactionId: 'txn_abc_123',
        amount: 13,
        currency: 'GBP',
        productName: 'Vodafone 10 GBP Topup',
        recipientPhone: '+447700900123',
        provider: 'reloadly',
        token: null,
        units: null,
      },
    })
    expect(typeof result.transaction.amount).toBe('number')
  })

  it('lowercases a PLANETTALK provider to "planettalk" in the transaction object', async () => {
    prisma.order.findUnique.mockResolvedValue({
      status: 'FULFILLED',
      provider: 'PLANETTALK',
      providerAmount: '5.50',
      providerCurrency: 'USD',
      productName: null,
      recipientPhone: '+254700000000',
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: 'txn_pt_999',
        lastError: null,
      },
    })

    const result = await controller.verify(PAYMENT_INTENT_ID)

    expect(result.transaction).toEqual({
      transactionId: 'txn_pt_999',
      amount: 5.5,
      currency: 'USD',
      productName: null,
      recipientPhone: '+254700000000',
      provider: 'planettalk',
      token: null,
      units: null,
    })
  })

  it('falls back to null transactionId when there is no fulfillment row', async () => {
    prisma.order.findUnique.mockResolvedValue({
      status: 'CREATED',
      provider: 'RELOADLY',
      providerAmount: '2.00',
      providerCurrency: 'GBP',
      productName: null,
      recipientPhone: null,
      fulfillment: null,
    })

    const result = await controller.verify(PAYMENT_INTENT_ID)

    expect(result.orderStatus).toBe('CREATED')
    expect(result.fulfillmentStatus).toBeNull()
    expect(result.transaction).toEqual({
      transactionId: null,
      amount: 2,
      currency: 'GBP',
      productName: null,
      recipientPhone: null,
      provider: 'reloadly',
      token: null,
      units: null,
    })
  })

  it('returns the electricity token/units from meta but never gift-card codes', async () => {
    prisma.order.findUnique.mockResolvedValue({
      status: 'FULFILLED',
      provider: 'PLANETTALK',
      providerAmount: '5000',
      providerCurrency: 'NGN',
      productName: 'IKEDC Prepaid',
      recipientPhone: '+2348055512345',
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: 'txn_elec_1',
        lastError: null,
        meta: { token: '1234-5678-9012-3456-7890', units: '38.5', cardCode: 'SHOULD_NOT_LEAK', cardPin: '9999' },
      },
    })

    const result = await controller.verify(PAYMENT_INTENT_ID)

    expect(result.transaction.token).toBe('1234-5678-9012-3456-7890')
    expect(result.transaction.units).toBe('38.5')
    // gift-card secrets must NEVER be returned by verify
    expect(JSON.stringify(result)).not.toContain('SHOULD_NOT_LEAK')
    expect(JSON.stringify(result)).not.toContain('9999')
  })

  it('throws 400 when paymentIntentId is missing', async () => {
    await expect(controller.verify('')).rejects.toBeInstanceOf(BadRequestException)
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('throws 404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null)

    await expect(controller.verify(PAYMENT_INTENT_ID)).rejects.toBeInstanceOf(NotFoundException)
  })
})

describe('PaymentsController.getGiftCardCode', () => {
  const PROVIDER_TXN_ID = 'txn_abc_123'

  let prisma: { order: { findUnique: jest.Mock } }
  let controller: PaymentsController

  function buildController() {
    return new PaymentsController(
      prisma as any,
      {} as any, // StripeService — unused
      {} as any, // PricingService — unused
      {} as any, // SignatureService — unused
      {} as any, // FulfillmentService — unused
      {} as any, // AlertService — unused
      {} as any, // HealthcareService — unused
    )
  }

  beforeEach(() => {
    prisma = { order: { findUnique: jest.fn() } }
    controller = buildController()
  })

  it('returns the gift card code when the fulfillment is FULFILLED and the providerTransactionId matches', async () => {
    prisma.order.findUnique.mockResolvedValue({
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444', cardPin: '5678', redemptionUrl: 'https://example.com/redeem' },
      },
    })

    const result = await controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)

    expect(result).toEqual({
      cardCode: '1111222233334444',
      cardPin: '5678',
      redemptionUrl: 'https://example.com/redeem',
    })
  })

  it('omits absent optional fields (no cardPin/redemptionUrl in meta)', async () => {
    prisma.order.findUnique.mockResolvedValue({
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444' },
      },
    })

    const result = await controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)

    expect(result).toEqual({ cardCode: '1111222233334444' })
  })

  it('throws 400 when paymentIntentId or providerTransactionId is missing', async () => {
    await expect(controller.getGiftCardCode('', PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, '')).rejects.toBeInstanceOf(
      BadRequestException,
    )
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('throws 404 when the order does not exist', async () => {
    prisma.order.findUnique.mockResolvedValue(null)

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('throws 403 when the providerTransactionId does not match the stored one', async () => {
    prisma.order.findUnique.mockResolvedValue({
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: 'txn_someone_else',
        meta: { cardCode: '1111222233334444' },
      },
    })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('throws 403 when the fulfillment is not yet FULFILLED', async () => {
    prisma.order.findUnique.mockResolvedValue({
      fulfillment: {
        status: 'PROCESSING',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444' },
      },
    })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('throws 403 when there is no fulfillment row at all', async () => {
    prisma.order.findUnique.mockResolvedValue({ fulfillment: null })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('throws 404 when fulfilled/owned but meta has no cardCode (e.g. a non-gift-card order)', async () => {
    prisma.order.findUnique.mockResolvedValue({
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { token: 'ABC', units: '42kWh' },
      },
    })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    )
  })

  it('throws 403 when the order was refunded, even though fulfillment is FULFILLED and the txn matches', async () => {
    prisma.order.findUnique.mockResolvedValue({
      refunded: true,
      disputed: false,
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444' },
      },
    })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('throws 403 when the order is under dispute, even though fulfillment is FULFILLED and the txn matches', async () => {
    prisma.order.findUnique.mockResolvedValue({
      refunded: false,
      disputed: true,
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444' },
      },
    })

    await expect(controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)).rejects.toBeInstanceOf(
      ForbiddenException,
    )
  })

  it('returns the code for a clean FULFILLED order (refunded/disputed both false) with a matching txn', async () => {
    prisma.order.findUnique.mockResolvedValue({
      refunded: false,
      disputed: false,
      fulfillment: {
        status: 'FULFILLED',
        providerTransactionId: PROVIDER_TXN_ID,
        meta: { cardCode: '1111222233334444' },
      },
    })

    const result = await controller.getGiftCardCode(PAYMENT_INTENT_ID, PROVIDER_TXN_ID)

    expect(result).toEqual({ cardCode: '1111222233334444' })
  })
})

// ---------------------------------------------------------------------------
// Auth-then-capture.
//
// Under `capture_method: 'manual'` Stripe fires `payment_intent.amount_capturable_updated`
// at AUTHORISATION and `payment_intent.succeeded` only after we capture. So fulfilment has
// to trigger on the former, and capture becomes something we do — after the provider has
// actually delivered. A failure that cannot be retried releases the hold instead of
// leaving the customer's money sitting on an authorisation.
// ---------------------------------------------------------------------------
describe('PaymentsController.webhook (manual capture)', () => {
  let prisma: { order: { updateMany: jest.Mock } }
  let stripe: { constructEvent: jest.Mock; client: { paymentIntents: { capture: jest.Mock; cancel: jest.Mock } } }
  let fulfillment: { fulfillByPaymentIntentId: jest.Mock }
  let alert: { notify: jest.Mock }
  let controller: PaymentsController

  function capturableEvent(id = 'pi_test_123') {
    return {
      type: 'payment_intent.amount_capturable_updated',
      data: { object: { id, metadata: { source: 'planettalk-topup' } } },
    }
  }

  beforeEach(() => {
    prisma = { order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) } }
    stripe = {
      constructEvent: jest.fn(),
      client: {
        paymentIntents: {
          capture: jest.fn().mockResolvedValue({ id: 'pi_test_123', status: 'succeeded' }),
          cancel: jest.fn().mockResolvedValue({ id: 'pi_test_123', status: 'canceled' }),
        },
      },
    }
    fulfillment = { fulfillByPaymentIntentId: jest.fn().mockResolvedValue({ status: 'fulfilled' }) }
    alert = { notify: jest.fn().mockResolvedValue(undefined) }
    controller = new PaymentsController(
      prisma as any, stripe as any, {} as any, {} as any, fulfillment as any, alert as any,
      {} as any, // HealthcareService — unused
    )
  })

  it('fulfils on amount_capturable_updated — the authorisation event', async () => {
    stripe.constructEvent.mockReturnValue(capturableEvent())
    await controller.webhook(buildReq())
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith('pi_test_123')
  })

  it('leaves capture to the fulfilment service, which every caller goes through', async () => {
    // Capture lives in FulfillmentService so reconciliation's recovery path captures too.
    // Capturing here as well would double-capture.
    stripe.constructEvent.mockReturnValue(capturableEvent())
    await controller.webhook(buildReq())
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith('pi_test_123')
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled()
  })

  it('releases the hold when fulfilment fails permanently', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
      new FulfillmentError('Amount paid does not cover this order', 402),
    )
    stripe.constructEvent.mockReturnValue(capturableEvent())

    await controller.webhook(buildReq())

    expect(stripe.client.paymentIntents.cancel).toHaveBeenCalledWith('pi_test_123')
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled()
  })

  // Incident 2026-10-03: the hold was released (Stripe: Canceled) but the order stayed
  // PAID, so verify told the customer "payment successful, contact support" and the admin
  // showed PAID for money that was never taken.
  it('records the released hold on the order as CANCELED so verify and the admin say "not charged"', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
      new FulfillmentError('Sorry, an error occurred while initiating the airtime purchase.', 400),
    )
    stripe.constructEvent.mockReturnValue(capturableEvent())

    await controller.webhook(buildReq())

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentIntentId: 'pi_test_123', status: { in: ['CREATED', 'PAID', 'FAILED'] } },
      data: { status: 'CANCELED' },
    })
  })

  // Every other way a payment gets cancelled — the 7-day authorisation expiry, a cancel in
  // the Stripe dashboard — arrives only as this event. Ignoring it left the admin on PAID.
  it('marks the order CANCELED on payment_intent.canceled, whatever cancelled it', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'payment_intent.canceled',
      data: { object: { id: 'pi_test_123', cancellation_reason: 'automatic', metadata: { source: 'planettalk-topup' } } },
    })

    const res = await controller.webhook(buildReq())

    expect(res).toEqual({ received: true })
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { paymentIntentId: 'pi_test_123', status: { in: ['CREATED', 'PAID', 'FAILED'] } },
      data: { status: 'CANCELED' },
    })
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
  })

  it('does NOT mark the order failed when releasing the hold itself fails — the funds are still held', async () => {
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(new FulfillmentError('refused', 400))
    stripe.client.paymentIntents.cancel.mockRejectedValue(new Error('stripe down'))
    stripe.constructEvent.mockReturnValue(capturableEvent())

    await controller.webhook(buildReq())

    expect(prisma.order.updateMany).not.toHaveBeenCalled()
    expect(alert.notify).toHaveBeenCalledWith(expect.stringContaining('still held'), 'critical')
  })

  it('keeps the hold on a RETRYABLE failure so Stripe can redeliver', async () => {
    // Cancelling here would throw away a payment that is about to succeed on retry.
    fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
      new FulfillmentError('Reloadly is down', 502, { retryable: true }),
    )
    stripe.constructEvent.mockReturnValue(capturableEvent())

    await expect(controller.webhook(buildReq())).rejects.toThrow()
    expect(stripe.client.paymentIntents.cancel).not.toHaveBeenCalled()
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled()
  })

  it('ignores intents that are not ours', async () => {
    stripe.constructEvent.mockReturnValue({
      type: 'payment_intent.amount_capturable_updated',
      data: { object: { id: 'pi_other', metadata: {} } },
    })
    await controller.webhook(buildReq())
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled()
  })

  it('does not re-fulfil on the succeeded event that our own capture triggers', async () => {
    // Capturing fires payment_intent.succeeded. Fulfilment is idempotent, but there is no
    // reason to re-enter it, and doing so would make every order look fulfilled twice.
    stripe.constructEvent.mockReturnValue({
      type: 'payment_intent.succeeded',
      data: { object: { id: 'pi_test_123', metadata: { source: 'planettalk-topup' }, status: 'succeeded' } },
    })
    await controller.webhook(buildReq())
    expect(stripe.client.paymentIntents.capture).not.toHaveBeenCalled()
  })
})

describe('PaymentsController.createIntent — healthcare', () => {
  let prisma: { order: { create: jest.Mock } }
  let stripe: { hasConfig: jest.Mock; client: { paymentIntents: { create: jest.Mock } } }
  let pricing: { priceOrder: jest.Mock }
  let healthcare: { findPharmacy: jest.Mock; resolveDrugLines: jest.Mock }
  let controller: PaymentsController

  const pharmacyOrderDto = () => ({
    productType: 'healthcare' as const,
    countryCode: 'NG',
    providerAmount: 1824,
    providerCurrency: 'NGN',
    email: 'buyer@example.com',
    phone: '+447700900000',
    pharmacyCode: 'WHP10431Test',
    patient: {
      firstName: ' Ada ',
      lastName: 'Obi',
      gender: 'Female' as const,
      phone: '08012345678',
      address: '1 Allen Avenue, Ikeja, Lagos',
    },
    drugs: [{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2 }],
  })

  beforeEach(() => {
    process.env.FULFILLMENT_SIGNING_SECRET = 'test-secret'
    prisma = { order: { create: jest.fn().mockResolvedValue({}) } }
    stripe = {
      hasConfig: jest.fn().mockReturnValue(true),
      client: { paymentIntents: { create: jest.fn().mockResolvedValue({ id: 'pi_h_1', client_secret: 's' }) } },
    }
    pricing = { priceOrder: jest.fn().mockResolvedValue(1.5) }
    healthcare = {
      findPharmacy: jest.fn().mockResolvedValue({ pharmacyCode: 'WHP10431Test' }),
      resolveDrugLines: jest.fn(async (lines: any[]) => lines.map((l) => ({ ...l, unitPrice: 912 }))),
    }
    controller = new PaymentsController(
      prisma as any,
      stripe as any,
      pricing as any,
      new SignatureService(),
      {} as any,
      {} as any,
      healthcare as any,
    )
  })

  it('prices server-side, keeps details out of Stripe and persists them on the order row', async () => {
    const res = await controller.createIntent({ currency: 'gbp', order: pharmacyOrderDto() } as any)

    expect(res).toMatchObject({ paymentIntentId: 'pi_h_1', amount: 1.5, currency: 'GBP' })

    const priced = pricing.priceOrder.mock.calls[0][0]
    expect(priced).toMatchObject({ productType: 'healthcare', productId: 1951, providerAmount: 1824 })
    expect(priced.details.drugs).toEqual([{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, unitPrice: 912 }])
    expect(priced.details.patient.firstName).toBe('Ada')

    const { metadata, capture_method } = stripe.client.paymentIntents.create.mock.calls[0][0]
    expect(capture_method).toBe('manual')
    expect(metadata).toMatchObject({ productType: 'healthcare', productId: '1951', provider: 'planettalk' })
    expect(metadata.detailsHash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(metadata)).not.toMatch(/Ada|Allen|EMZOR/)

    const row = prisma.order.create.mock.calls[0][0].data
    expect(row).toMatchObject({
      productType: 'HEALTHCARE',
      provider: 'PLANETTALK',
      productId: '1951',
      accountNumber: 'WHP10431Test',
      recipientPhone: '08012345678',
    })
    expect(row.details).toEqual(priced.details)
  })

  it('409s with the current total when the displayed total is stale', async () => {
    const err = await controller
      .createIntent({ currency: 'gbp', order: { ...pharmacyOrderDto(), providerAmount: 1500 } } as any)
      .catch((e) => e)

    expect(err.getStatus()).toBe(409)
    expect(stripe.client.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('400s for an unknown pharmacy', async () => {
    healthcare.findPharmacy.mockResolvedValue(null)
    const err = await controller.createIntent({ currency: 'gbp', order: pharmacyOrderDto() } as any).catch((e) => e)
    expect(err.getStatus()).toBe(400)
    expect(stripe.client.paymentIntents.create).not.toHaveBeenCalled()
  })

  it('422s for a medication that is no longer listed', async () => {
    healthcare.resolveDrugLines.mockRejectedValue(new NotFoundException('"X" is no longer available'))
    const err = await controller.createIntent({ currency: 'gbp', order: pharmacyOrderDto() } as any).catch((e) => e)
    expect(err.getStatus()).toBe(422)
  })

  it('400s for an invalid beneficiary before any charge', async () => {
    const dto = pharmacyOrderDto()
    dto.patient.phone = '123'
    const err = await controller.createIntent({ currency: 'gbp', order: dto } as any).catch((e) => e)
    expect(err.getStatus()).toBe(400)
    expect(stripe.client.paymentIntents.create).not.toHaveBeenCalled()
  })
})
