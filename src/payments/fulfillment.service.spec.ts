import { Test } from '@nestjs/testing'
import { FulfillmentService, FulfillmentError } from './fulfillment.service'
import { PrismaService } from '../common/prisma.service'
import { StripeService } from './stripe.service'
import { PricingService } from './pricing.service'
import { SignatureService, FULFILLMENT_SIG_META } from './signature.service'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { buildFulfillmentMetadata } from './order-metadata'
import type { TopupFulfillmentOrder } from './payments.types'

const fulfillmentOrder: TopupFulfillmentOrder = {
  productType: 'topup',
  countryCode: 'GB',
  operatorId: 1,
  recipientPhone: '+447700900000',
  providerAmount: 10,
  providerCurrency: 'GBP',
  useLocalAmount: false,
}

const ORDER_ROW_ID = 'order-row-1'
const PAYMENT_INTENT_ID = 'pi_test_123'

function buildPi(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: PAYMENT_INTENT_ID,
    status: 'succeeded',
    currency: 'gbp',
    amount_received: 1300, // £13.00 in minor units
    metadata: buildFulfillmentMetadata(fulfillmentOrder),
    ...overrides,
  }
}

function buildOrderRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: ORDER_ROW_ID,
    paymentIntentId: PAYMENT_INTENT_ID,
    productType: 'TOPUP',
    provider: 'RELOADLY',
    countryCode: 'GB',
    status: 'CREATED',
    fulfillment: { id: 'fulfillment-1', orderId: ORDER_ROW_ID, status: 'PENDING' },
    ...overrides,
  }
}

describe('FulfillmentService', () => {
  let prisma: {
    order: { findUnique: jest.Mock; update: jest.Mock }
    $transaction: jest.Mock
  }
  let txMock: {
    $queryRaw: jest.Mock
    fulfillment: { update: jest.Mock }
    order: { update: jest.Mock }
    providerCallLog: { create: jest.Mock }
  }
  let stripe: { client: { paymentIntents: { retrieve: jest.Mock } } }
  let pricing: { priceOrder: jest.Mock }
  let signature: { hasSecret: jest.Mock; verify: jest.Mock }
  let executor: { execute: jest.Mock }
  let service: FulfillmentService

  beforeEach(async () => {
    txMock = {
      $queryRaw: jest.fn(),
      fulfillment: { update: jest.fn().mockResolvedValue({}) },
      order: { update: jest.fn().mockResolvedValue({}) },
      providerCallLog: { create: jest.fn().mockResolvedValue({}) },
    }

    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(buildOrderRow()),
        update: jest.fn().mockResolvedValue({}),
      },
      $transaction: jest.fn((cb: (tx: typeof txMock) => unknown) => cb(txMock)),
    }

    stripe = {
      client: { paymentIntents: { retrieve: jest.fn().mockResolvedValue(buildPi()) } },
    }

    pricing = { priceOrder: jest.fn().mockResolvedValue(13.0) } // matches amount_received=1300 @ GBP

    signature = { hasSecret: jest.fn().mockReturnValue(false), verify: jest.fn() }

    executor = {
      execute: jest.fn().mockResolvedValue({
        transactionId: 999,
        status: 'SUCCESSFUL',
        timestamp: new Date().toISOString(),
        provider: 'reloadly',
      }),
    }

    const moduleRef = await Test.createTestingModule({
      providers: [
        FulfillmentService,
        { provide: PrismaService, useValue: prisma },
        { provide: StripeService, useValue: stripe },
        { provide: PricingService, useValue: pricing },
        { provide: SignatureService, useValue: signature },
        { provide: ReloadlyTopupExecutor, useValue: executor },
      ],
    }).compile()

    service = moduleRef.get(FulfillmentService)
  })

  it('fulfils a PENDING order once', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'topup', operatorId: 1 }),
      PAYMENT_INTENT_ID
    )

    // order marked PAID before the claim, then FULFILLED after success
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID },
      data: { status: 'PAID' },
    })

    expect(txMock.fulfillment.update).toHaveBeenNthCalledWith(1, {
      where: { orderId: ORDER_ROW_ID },
      data: { status: 'PROCESSING', processingClaimedAt: expect.any(Date) },
    })
    expect(txMock.fulfillment.update).toHaveBeenNthCalledWith(2, {
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '999',
        fulfilledAt: expect.any(Date),
      },
    })

    expect(txMock.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID },
      data: { status: 'FULFILLED' },
    })

    expect(txMock.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/topups',
        method: 'POST',
        success: true,
        responseStatus: 200,
      },
    })
  })

  it('no-ops when fulfillment already terminal (replay)', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'FULFILLED' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'already' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(txMock.fulfillment.update).not.toHaveBeenCalled()
    expect(txMock.providerCallLog.create).not.toHaveBeenCalled()
  })

  it('no-ops when no fulfillment row exists for the order', async () => {
    txMock.$queryRaw.mockResolvedValue([])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'already' })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('throws 404 when no order exists for the paymentIntentId', async () => {
    prisma.order.findUnique.mockResolvedValue(null)

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 404,
    })
    expect(stripe.client.paymentIntents.retrieve).not.toHaveBeenCalled()
  })

  it('throws 402 when the payment intent has not succeeded', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(buildPi({ status: 'requires_action' }))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 402,
      message: 'Payment has not succeeded',
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('throws 402 when amount_received < authoritative', async () => {
    // authoritative price is £13.00 => expected 1300 minor units; amount_received is only 1000
    stripe.client.paymentIntents.retrieve.mockResolvedValue(buildPi({ amount_received: 1000 }))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 402,
      message: 'Amount paid does not cover this order',
    })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('propagates a PricingError statusCode via FulfillmentError', async () => {
    const { PricingError } = await import('./pricing.service')
    pricing.priceOrder.mockRejectedValue(new PricingError('Operator is not available for this country', 400))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 400,
      message: 'Operator is not available for this country',
    })
  })

  it('wraps a non-pricing error from priceOrder as a retryable 502', async () => {
    pricing.priceOrder.mockRejectedValue(new Error('network blip'))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 502,
      retryable: true,
    })
  })

  it('rejects with 403 when a present binding signature does not verify', async () => {
    signature.hasSecret.mockReturnValue(true)
    signature.verify.mockReturnValue(false)
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: { ...buildFulfillmentMetadata(fulfillmentOrder), [FULFILLMENT_SIG_META]: 'bad-sig' } })
    )

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 403,
      message: 'This payment was not initiated through our checkout',
    })
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('allows a missing signature when a secret is configured (pre-migration intent)', async () => {
    signature.hasSecret.mockReturnValue(true)
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(signature.verify).not.toHaveBeenCalled()
  })

  it('rejects unsupported product types with a 501 before touching the transaction', async () => {
    const { PricingError } = await import('./pricing.service')
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({
        metadata: buildFulfillmentMetadata({
          productType: 'giftcard',
          countryCode: 'GB',
          productId: 42,
          providerAmount: 10,
          providerCurrency: 'GBP',
        } as any),
      })
    )
    pricing.priceOrder.mockRejectedValue(new PricingError('Not implemented in SP-2 slice', 501))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 501,
    })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('executor throws retryable error: Fulfillment FAILED + failure ProviderCallLog + rethrown as retryable FulfillmentError', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    const providerError = Object.assign(new Error('Operator currently unavailable'), {
      retryable: true,
      statusCode: 503,
    })
    executor.execute.mockRejectedValue(providerError)

    const thrown = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID).catch((e: unknown) => e)
    expect(thrown).toBeInstanceOf(FulfillmentError)
    expect(thrown).toMatchObject({
      statusCode: 503,
      retryable: true,
      message: 'Operator currently unavailable',
    })

    expect(txMock.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FAILED',
        lastError: 'Operator currently unavailable',
        attempts: { increment: 1 },
      },
    })

    expect(txMock.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/topups',
        method: 'POST',
        success: false,
        error: 'Operator currently unavailable',
        responseStatus: 503,
      },
    })

    // Order itself stays PAID — never marked FULFILLED on a failed attempt.
    expect(txMock.order.update).not.toHaveBeenCalled()
  })

  it('executor throws a non-retryable error: rethrown FulfillmentError has retryable=false/undefined', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    executor.execute.mockRejectedValue(new Error('Requested amount is not offered by this operator'))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 500,
      retryable: false,
    })
  })
})
