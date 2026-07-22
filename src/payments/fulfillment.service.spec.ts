import { Test } from '@nestjs/testing'
import { FulfillmentService, FulfillmentError } from './fulfillment.service'
import { PrismaService } from '../common/prisma.service'
import { StripeService } from './stripe.service'
import { PricingService } from './pricing.service'
import { SignatureService, FULFILLMENT_SIG_META } from './signature.service'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { ReloadlyGiftCardExecutor } from './executors/reloadly-gift-card.executor'
import { ReloadlyPayBillExecutor } from './executors/reloadly-pay-bill.executor'
import { PlanetTalkTopupExecutor } from './executors/planettalk-topup.executor'
import { PlanetTalkPayBillExecutor } from './executors/planettalk-pay-bill.executor'
import { buildFulfillmentMetadata } from './order-metadata'
import type { GiftCardFulfillmentOrder, TopupFulfillmentOrder, UtilityFulfillmentOrder } from './payments.types'

const fulfillmentOrder: TopupFulfillmentOrder = {
  productType: 'topup',
  countryCode: 'GB',
  operatorId: 1,
  recipientPhone: '+447700900000',
  providerAmount: 10,
  providerCurrency: 'GBP',
  useLocalAmount: false,
}

const giftCardFulfillmentOrder: GiftCardFulfillmentOrder = {
  productType: 'giftcard',
  countryCode: 'GB',
  productId: 42,
  providerAmount: 20,
  providerCurrency: 'GBP',
}

const utilityFulfillmentOrder: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'GB',
  billerId: 7,
  accountNumber: '04223568280',
  providerAmount: 10,
  providerCurrency: 'GBP',
}

const ngTopupFulfillmentOrder: TopupFulfillmentOrder = {
  productType: 'topup',
  countryCode: 'NG',
  operatorId: 100,
  recipientPhone: '08012345678',
  providerAmount: 200,
  providerCurrency: 'NGN',
  useLocalAmount: true,
}

const ngUtilityFulfillmentOrder: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'NG',
  billerId: 42,
  accountNumber: '1234567890',
  providerAmount: 20000,
  providerCurrency: 'NGN',
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
    order: { findUnique: jest.Mock; update: jest.Mock; updateMany: jest.Mock }
    fulfillment: { update: jest.Mock }
    providerCallLog: { create: jest.Mock }
    $transaction: jest.Mock
  }
  // The mock "tx" handed to the callback passed into prisma.$transaction. Under the
  // three-phase structure this is used ONLY for the claim (SELECT ... FOR UPDATE +
  // the PROCESSING write) — never for the executor call or the result writes, which
  // go through `prisma.*` directly (see the `prisma` mock above).
  let txMock: {
    $queryRaw: jest.Mock
    fulfillment: { update: jest.Mock }
  }
  let stripe: { client: { paymentIntents: { retrieve: jest.Mock } } }
  let pricing: { priceOrder: jest.Mock }
  let signature: { hasSecret: jest.Mock; verify: jest.Mock }
  let executor: { execute: jest.Mock }
  let giftCardExecutor: { execute: jest.Mock }
  let payBillExecutor: { execute: jest.Mock }
  let planetTalkTopupExecutor: { execute: jest.Mock }
  let planetTalkPayBillExecutor: { execute: jest.Mock }
  let service: FulfillmentService

  beforeEach(async () => {
    txMock = {
      $queryRaw: jest.fn(),
      fulfillment: { update: jest.fn().mockResolvedValue({}) },
    }

    prisma = {
      order: {
        findUnique: jest.fn().mockResolvedValue(buildOrderRow()),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      fulfillment: { update: jest.fn().mockResolvedValue({}) },
      providerCallLog: { create: jest.fn().mockResolvedValue({}) },
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

    giftCardExecutor = {
      execute: jest.fn().mockResolvedValue({
        transaction: {
          transactionId: 888,
          status: 'SUCCESSFUL',
          timestamp: new Date().toISOString(),
          provider: 'reloadly',
        },
        giftCard: { cardCode: 'CARD-CODE-123', cardPin: '9999' },
      }),
    }

    payBillExecutor = {
      execute: jest.fn().mockResolvedValue({
        transactionId: 777,
        billerId: 7,
        status: 'SUCCESSFUL',
        timestamp: new Date().toISOString(),
        provider: 'reloadly',
      }),
    }

    planetTalkTopupExecutor = {
      execute: jest.fn().mockResolvedValue({
        transactionId: 555,
        status: 'SUCCESSFUL',
        deliveryStatus: 'DELIVERED',
        meta: null,
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
      }),
    }

    planetTalkPayBillExecutor = {
      execute: jest.fn().mockResolvedValue({
        transactionId: 666,
        billerId: 42,
        status: 'SUCCESSFUL',
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
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
        { provide: ReloadlyGiftCardExecutor, useValue: giftCardExecutor },
        { provide: ReloadlyPayBillExecutor, useValue: payBillExecutor },
        { provide: PlanetTalkTopupExecutor, useValue: planetTalkTopupExecutor },
        { provide: PlanetTalkPayBillExecutor, useValue: planetTalkPayBillExecutor },
      ],
    }).compile()

    service = moduleRef.get(FulfillmentService)
  })

  it('PENDING claim → fulfilled (fulfils a PENDING order once)', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'topup', operatorId: 1 }),
      PAYMENT_INTENT_ID
    )

    // order guarded-promoted CREATED->PAID before the claim, then FULFILLED after success
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID, status: 'CREATED' },
      data: { status: 'PAID' },
    })
    expect(prisma.order.update).toHaveBeenCalledTimes(1)
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID },
      data: { status: 'FULFILLED' },
    })

    // Phase 1 (claim) runs inside the $transaction, against the tx client only.
    expect(txMock.fulfillment.update).toHaveBeenCalledTimes(1)
    expect(txMock.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: { status: 'PROCESSING', processingClaimedAt: expect.any(Date) },
    })

    // Phase 3 (success writes) run outside the transaction, against prisma directly.
    expect(prisma.fulfillment.update).toHaveBeenCalledTimes(1)
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '999',
        fulfilledAt: expect.any(Date),
      },
    })

    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
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

  it('replay (already terminal) → already', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'FULFILLED' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'already' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(txMock.fulfillment.update).not.toHaveBeenCalled()
    expect(prisma.fulfillment.update).not.toHaveBeenCalled()
    expect(prisma.providerCallLog.create).not.toHaveBeenCalled()
  })

  it('replay on an already-FULFILLED order does NOT downgrade order.status back to PAID', async () => {
    // Regression test for the live E2E bug: a Stripe webhook replayed against an order
    // whose fulfillment row is already FULFILLED must never re-write order.status to
    // PAID. The claim's $queryRaw sees the terminal FULFILLED row and returns 'already'
    // before the executor (or any fulfillment write) ever runs.
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'FULFILLED' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    // (a) returns 'already'
    expect(result).toEqual({ status: 'already' })
    // (b) executor NOT called
    expect(executor.execute).not.toHaveBeenCalled()

    // (c) the PAID transition was issued via a guarded updateMany whose where clause
    // includes status: 'CREATED' — so it can only ever promote a fresh order, never
    // touch a row that is already FULFILLED.
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID, status: 'CREATED' },
      data: { status: 'PAID' },
    })

    // (d) no order.update/updateMany call anywhere sets status: 'PAID' without the
    // status: 'CREATED' guard — i.e. every PAID-setting call is guarded, so a
    // FULFILLED order is never downgraded.
    const allOrderCalls = [...prisma.order.update.mock.calls, ...prisma.order.updateMany.mock.calls]
    for (const call of allOrderCalls) {
      if (call[0]?.data?.status === 'PAID') {
        expect(call[0]?.where?.status).toBe('CREATED')
      }
    }
    // order.update (the unconditional variant) must never be called at all in this
    // replay path — the order row is left completely untouched.
    expect(prisma.order.update).not.toHaveBeenCalled()
  })

  it('PROCESSING (in-flight elsewhere) → already', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PROCESSING' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'already' })
    expect(executor.execute).not.toHaveBeenCalled()
    expect(txMock.fulfillment.update).not.toHaveBeenCalled()
    expect(prisma.fulfillment.update).not.toHaveBeenCalled()
    expect(prisma.providerCallLog.create).not.toHaveBeenCalled()
  })

  it('FAILED row is re-claimed on Stripe redelivery (recovers a stranded PAID order)', async () => {
    // A previous attempt hit a retryable executor failure and left the row FAILED; the
    // webhook returned 5xx so Stripe redelivers. Redelivery must re-claim FAILED (not
    // just PENDING) or the PAID order would be stranded forever.
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'FAILED' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(txMock.fulfillment.update).toHaveBeenCalledTimes(1)
    expect(txMock.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: { status: 'PROCESSING', processingClaimedAt: expect.any(Date) },
    })
    expect(executor.execute).toHaveBeenCalledTimes(1)
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '999',
        fulfilledAt: expect.any(Date),
      },
    })
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
          productType: 'utility',
          countryCode: 'GB',
          billerId: 7,
          accountNumber: '12345',
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

  it('giftcard: PENDING claim -> fulfilled, dispatches to the gift-card executor and persists the card code in Fulfillment.meta', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: buildFulfillmentMetadata(giftCardFulfillmentOrder) })
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(giftCardExecutor.execute).toHaveBeenCalledTimes(1)
    expect(giftCardExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'giftcard', productId: 42 }),
      PAYMENT_INTENT_ID
    )
    expect(executor.execute).not.toHaveBeenCalled()

    // The delivered card code (+ pin) is persisted into Fulfillment.meta alongside the
    // usual FULFILLED status + providerTransactionId.
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '888',
        fulfilledAt: expect.any(Date),
        meta: { cardCode: 'CARD-CODE-123', cardPin: '9999' },
      },
    })
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID },
      data: { status: 'FULFILLED' },
    })
    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/orders',
        method: 'POST',
        success: true,
        responseStatus: 200,
      },
    })
  })

  it('giftcard: executor failure is recorded (FAILED + failure ProviderCallLog) without writing any Fulfillment.meta', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: buildFulfillmentMetadata(giftCardFulfillmentOrder) })
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    const providerError = Object.assign(new Error('Gift card product unavailable'), {
      retryable: true,
      statusCode: 503,
    })
    giftCardExecutor.execute.mockRejectedValue(providerError)

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 503,
      retryable: true,
    })

    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FAILED',
        lastError: 'Gift card product unavailable',
        attempts: { increment: 1 },
      },
    })
    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/orders',
        method: 'POST',
        success: false,
        error: 'Gift card product unavailable',
        responseStatus: 503,
      },
    })
  })

  it('utility: PENDING claim -> fulfilled, dispatches to the pay-bill executor and persists returned meta (e.g. electricity token/units)', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: buildFulfillmentMetadata(utilityFulfillmentOrder) })
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    payBillExecutor.execute.mockResolvedValue({
      transactionId: 777,
      billerId: 7,
      status: 'SUCCESSFUL',
      meta: { token: '1234-5678-9012-3456', units: '45.2kWh' },
      timestamp: new Date().toISOString(),
      provider: 'reloadly',
    })

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(payBillExecutor.execute).toHaveBeenCalledTimes(1)
    expect(payBillExecutor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'utility', billerId: 7 }),
      PAYMENT_INTENT_ID
    )
    expect(executor.execute).not.toHaveBeenCalled()
    expect(giftCardExecutor.execute).not.toHaveBeenCalled()

    // The provider-returned meta (electricity token/units) is persisted into
    // Fulfillment.meta alongside the usual FULFILLED status + providerTransactionId.
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '777',
        fulfilledAt: expect.any(Date),
        meta: { token: '1234-5678-9012-3456', units: '45.2kWh' },
      },
    })
    expect(prisma.order.update).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID },
      data: { status: 'FULFILLED' },
    })
    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/pay',
        method: 'POST',
        success: true,
        responseStatus: 200,
      },
    })
  })

  it('utility: no meta on the transaction -> Fulfillment.update is called without a meta field', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: buildFulfillmentMetadata(utilityFulfillmentOrder) })
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    // payBillExecutor default mock resolves a transaction with no `meta` key.

    const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

    expect(result).toEqual({ status: 'fulfilled' })
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FULFILLED',
        providerTransactionId: '777',
        fulfilledAt: expect.any(Date),
      },
    })
  })

  it('utility: executor failure is recorded (FAILED + failure ProviderCallLog against the /pay endpoint)', async () => {
    stripe.client.paymentIntents.retrieve.mockResolvedValue(
      buildPi({ metadata: buildFulfillmentMetadata(utilityFulfillmentOrder) })
    )
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    const providerError = Object.assign(new Error('Biller is not available'), {
      retryable: false,
      statusCode: 400,
    })
    payBillExecutor.execute.mockRejectedValue(providerError)

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 400,
      retryable: false,
    })

    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FAILED',
        lastError: 'Biller is not available',
        attempts: { increment: 1 },
      },
    })
    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
      data: {
        orderId: ORDER_ROW_ID,
        provider: 'RELOADLY',
        endpoint: '/pay',
        method: 'POST',
        success: false,
        error: 'Biller is not available',
        responseStatus: 400,
      },
    })
  })

  describe('PlanetTalk dispatch (provider === planettalk)', () => {
    let originalEnv: string | undefined

    beforeEach(() => {
      originalEnv = process.env.TOPUP_PROVIDER_NG
      process.env.TOPUP_PROVIDER_NG = 'planettalk'
    })

    afterEach(() => {
      process.env.TOPUP_PROVIDER_NG = originalEnv
    })

    it('topup: PENDING claim -> fulfilled, dispatches to the PlanetTalk topup executor (not Reloadly) and persists returned meta', async () => {
      stripe.client.paymentIntents.retrieve.mockResolvedValue(
        buildPi({ metadata: buildFulfillmentMetadata(ngTopupFulfillmentOrder) })
      )
      txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
      planetTalkTopupExecutor.execute.mockResolvedValue({
        transactionId: 555,
        status: 'SUCCESSFUL',
        deliveryStatus: 'DELIVERED',
        meta: null,
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
      })

      const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

      expect(result).toEqual({ status: 'fulfilled' })
      expect(planetTalkTopupExecutor.execute).toHaveBeenCalledTimes(1)
      expect(planetTalkTopupExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ productType: 'topup', operatorId: 100, countryCode: 'NG' }),
        PAYMENT_INTENT_ID
      )
      // Neither the Reloadly topup executor nor the Reloadly/PlanetTalk pay-bill
      // executors are invoked for a PlanetTalk topup order.
      expect(executor.execute).not.toHaveBeenCalled()
      expect(payBillExecutor.execute).not.toHaveBeenCalled()
      expect(planetTalkPayBillExecutor.execute).not.toHaveBeenCalled()

      expect(prisma.fulfillment.update).toHaveBeenCalledWith({
        where: { orderId: ORDER_ROW_ID },
        data: {
          status: 'FULFILLED',
          providerTransactionId: '555',
          fulfilledAt: expect.any(Date),
        },
      })
      // ProviderCallLog is tagged PLANETTALK (not RELOADLY) for this dispatch.
      expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
        data: {
          orderId: ORDER_ROW_ID,
          provider: 'PLANETTALK',
          endpoint: '/products/purchase',
          method: 'POST',
          success: true,
          responseStatus: 200,
        },
      })
    })

    it('utility: PENDING claim -> fulfilled, dispatches to the PlanetTalk pay-bill executor (not Reloadly) and persists returned meta (e.g. electricity token/units)', async () => {
      stripe.client.paymentIntents.retrieve.mockResolvedValue(
        buildPi({ metadata: buildFulfillmentMetadata(ngUtilityFulfillmentOrder) })
      )
      txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
      planetTalkPayBillExecutor.execute.mockResolvedValue({
        transactionId: 666,
        billerId: 42,
        status: 'SUCCESSFUL',
        meta: { token: '1234-5678-9012-3456', units: '45.2kWh' },
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
      })

      const result = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)

      expect(result).toEqual({ status: 'fulfilled' })
      expect(planetTalkPayBillExecutor.execute).toHaveBeenCalledTimes(1)
      expect(planetTalkPayBillExecutor.execute).toHaveBeenCalledWith(
        expect.objectContaining({ productType: 'utility', billerId: 42, countryCode: 'NG' }),
        PAYMENT_INTENT_ID
      )
      expect(payBillExecutor.execute).not.toHaveBeenCalled()
      expect(planetTalkTopupExecutor.execute).not.toHaveBeenCalled()

      expect(prisma.fulfillment.update).toHaveBeenCalledWith({
        where: { orderId: ORDER_ROW_ID },
        data: {
          status: 'FULFILLED',
          providerTransactionId: '666',
          fulfilledAt: expect.any(Date),
          meta: { token: '1234-5678-9012-3456', units: '45.2kWh' },
        },
      })
      expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
        data: {
          orderId: ORDER_ROW_ID,
          provider: 'PLANETTALK',
          endpoint: '/products/purchase',
          method: 'POST',
          success: true,
          responseStatus: 200,
        },
      })
    })

    it('topup: PlanetTalk executor failure is recorded with provider PLANETTALK in the failure ProviderCallLog', async () => {
      stripe.client.paymentIntents.retrieve.mockResolvedValue(
        buildPi({ metadata: buildFulfillmentMetadata(ngTopupFulfillmentOrder) })
      )
      txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
      const providerError = Object.assign(new Error('No matching Planet Talk product found for this operator and amount'), {
        retryable: false,
        statusCode: 400,
      })
      planetTalkTopupExecutor.execute.mockRejectedValue(providerError)

      await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
        statusCode: 400,
        retryable: false,
      })

      expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
        data: {
          orderId: ORDER_ROW_ID,
          provider: 'PLANETTALK',
          endpoint: '/products/purchase',
          method: 'POST',
          success: false,
          error: 'No matching Planet Talk product found for this operator and amount',
          responseStatus: 400,
        },
      })
    })
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

    // Failure telemetry is written via `prisma.*` directly (not inside the doomed
    // claim transaction), so it persists even though the executor call failed.
    expect(prisma.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: {
        status: 'FAILED',
        lastError: 'Operator currently unavailable',
        attempts: { increment: 1 },
      },
    })

    expect(prisma.providerCallLog.create).toHaveBeenCalledWith({
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
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID, status: 'CREATED' },
      data: { status: 'PAID' },
    })
    expect(prisma.order.update).not.toHaveBeenCalled()
  })

  it('executor throws a non-retryable error: rethrown FulfillmentError has retryable=false/undefined', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    executor.execute.mockRejectedValue(new Error('Requested amount is not offered by this operator'))

    await expect(service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toMatchObject({
      statusCode: 500,
      retryable: false,
    })
  })

  it('success-write fails after successful execute → does NOT revert to PENDING', async () => {
    txMock.$queryRaw.mockResolvedValue([{ id: 'fulfillment-1', status: 'PENDING' }])
    const writeError = new Error('connection reset while writing FULFILLED')
    prisma.fulfillment.update.mockRejectedValue(writeError)

    const thrown = await service.fulfillByPaymentIntentId(PAYMENT_INTENT_ID).catch((e: unknown) => e)

    // The executor already succeeded and moved real value — the write failure must
    // propagate as-is (not be swallowed, and not be re-wrapped into a retry signal
    // that would cause a re-execution of the executor).
    expect(thrown).toBe(writeError)
    expect(executor.execute).toHaveBeenCalledTimes(1)

    // The one and only claim-transaction write set the row to PROCESSING. Assert
    // no call anywhere (claim tx or direct prisma) ever set status back to PENDING.
    expect(txMock.fulfillment.update).toHaveBeenCalledTimes(1)
    expect(txMock.fulfillment.update).toHaveBeenCalledWith({
      where: { orderId: ORDER_ROW_ID },
      data: { status: 'PROCESSING', processingClaimedAt: expect.any(Date) },
    })
    for (const call of txMock.fulfillment.update.mock.calls) {
      expect(call[0].data.status).not.toBe('PENDING')
    }
    for (const call of prisma.fulfillment.update.mock.calls) {
      expect(call[0].data.status).not.toBe('PENDING')
    }

    // Order was never advanced to FULFILLED (the attempted write threw before that ran).
    expect(prisma.order.updateMany).toHaveBeenCalledTimes(1)
    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: ORDER_ROW_ID, status: 'CREATED' },
      data: { status: 'PAID' },
    })
    expect(prisma.order.update).not.toHaveBeenCalled()
    expect(prisma.providerCallLog.create).not.toHaveBeenCalled()
  })
})
