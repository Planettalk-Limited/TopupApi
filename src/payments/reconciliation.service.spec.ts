import { Test } from '@nestjs/testing'
import {
  ReconciliationService,
  STALE_PROCESSING_MS,
  RETRY_DELAY_MS,
  MAX_ATTEMPTS,
  ALERT_WINDOW_MS,
  MAX_RECOVERIES_PER_RUN,
} from './reconciliation.service'
import { PrismaService } from '../common/prisma.service'
import { AlertService } from '../common/alert.service'
import { FulfillmentService, FulfillmentError } from './fulfillment.service'

describe('ReconciliationService', () => {
  let prisma: {
    fulfillment: { updateMany: jest.Mock; findMany: jest.Mock }
    order: { findMany: jest.Mock }
  }
  let fulfillment: { fulfillByPaymentIntentId: jest.Mock }
  let alert: { notify: jest.Mock }
  let service: ReconciliationService

  beforeEach(async () => {
    prisma = {
      fulfillment: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        findMany: jest.fn().mockResolvedValue([]),
      },
      order: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    }
    fulfillment = { fulfillByPaymentIntentId: jest.fn().mockResolvedValue({ status: 'fulfilled' }) }
    alert = { notify: jest.fn().mockResolvedValue(undefined) }

    const moduleRef = await Test.createTestingModule({
      providers: [
        ReconciliationService,
        { provide: PrismaService, useValue: prisma },
        { provide: FulfillmentService, useValue: fulfillment },
        { provide: AlertService, useValue: alert },
      ],
    }).compile()

    service = moduleRef.get(ReconciliationService)
  })

  afterEach(() => {
    jest.useRealTimers()
  })

  it('resets stale PROCESSING fulfillments to FAILED via a bulk updateMany with the right where/data', async () => {
    await service.reconcile()

    expect(prisma.fulfillment.updateMany).toHaveBeenCalledTimes(1)
    const call = prisma.fulfillment.updateMany.mock.calls[0][0]
    expect(call.where.status).toBe('PROCESSING')
    expect(call.where.processingClaimedAt.lt).toBeInstanceOf(Date)
    expect(call.data).toEqual({
      status: 'FAILED',
      lastError: 'stale processing lock reclaimed by reconciliation',
    })

    // The cutoff is "now - STALE_PROCESSING_MS" — sanity check the magnitude (not an
    // exact clock assertion, just that it's in the right ballpark).
    const deltaMs = Date.now() - call.where.processingClaimedAt.lt.getTime()
    expect(deltaMs).toBeGreaterThanOrEqual(STALE_PROCESSING_MS - 1000)
    expect(deltaMs).toBeLessThanOrEqual(STALE_PROCESSING_MS + 5000)
  })

  it('recovers a PAID order with a PENDING fulfillment past the retry delay by calling fulfillByPaymentIntentId', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1', paymentIntentId: 'pi_stuck_1' }])

    await service.reconcile()

    expect(prisma.order.findMany).toHaveBeenCalledTimes(1)
    const args = prisma.order.findMany.mock.calls[0][0]
    expect(args.where.status).toBe('PAID')
    expect(args.where.updatedAt.lt).toBeInstanceOf(Date)
    expect(args.where.fulfillment).toEqual({
      status: { in: ['PENDING', 'FAILED'] },
      attempts: { lt: MAX_ATTEMPTS },
    })
    expect(args.take).toBe(MAX_RECOVERIES_PER_RUN)

    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledTimes(1)
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith('pi_stuck_1')

    // Query cutoff should reflect RETRY_DELAY_MS so we don't race the webhook.
    const deltaMs = Date.now() - args.where.updatedAt.lt.getTime()
    expect(deltaMs).toBeGreaterThanOrEqual(RETRY_DELAY_MS - 1000)
    expect(deltaMs).toBeLessThanOrEqual(RETRY_DELAY_MS + 5000)
  })

  it('does NOT retry a fresh PAID+PENDING order (query already filters to updatedAt older than RETRY_DELAY_MS, so a fresh order is excluded at the DB level)', async () => {
    // Simulate the DB-level filter doing its job: a fresh order (within RETRY_DELAY)
    // is never returned by the query in the first place.
    prisma.order.findMany.mockResolvedValue([])

    await service.reconcile()

    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
    // But the where clause used to query must still encode the delay -- verified above;
    // here we additionally assert the query was issued with a strictly-less-than filter
    // (so a just-updated order's updatedAt would not satisfy it).
    const args = prisma.order.findMany.mock.calls[0][0]
    expect(Object.keys(args.where.updatedAt)).toEqual(['lt'])
  })

  it('excludes FAILED orders already at MAX_ATTEMPTS from the recovery query (attempts < MAX_ATTEMPTS filter)', async () => {
    await service.reconcile()

    const args = prisma.order.findMany.mock.calls[0][0]
    expect(args.where.fulfillment.attempts).toEqual({ lt: MAX_ATTEMPTS })
  })

  it('alerts on a FAILED fulfillment at MAX_ATTEMPTS and does NOT attempt to retry it', async () => {
    prisma.fulfillment.findMany.mockResolvedValue([
      {
        orderId: 'order-2',
        attempts: MAX_ATTEMPTS,
        lastError: 'Operator permanently unavailable',
        status: 'FAILED',
        order: { id: 'order-2', paymentIntentId: 'pi_dead_1' },
      },
    ])

    await service.reconcile()

    expect(prisma.fulfillment.findMany).toHaveBeenCalledTimes(1)
    const args = prisma.fulfillment.findMany.mock.calls[0][0]
    expect(args.where.status).toBe('FAILED')
    expect(args.where.attempts).toEqual({ gte: MAX_ATTEMPTS })
    expect(args.where.updatedAt.gte).toBeInstanceOf(Date)

    expect(alert.notify).toHaveBeenCalledTimes(1)
    expect(alert.notify).toHaveBeenCalledWith(expect.stringContaining('pi_dead_1'), 'critical')
    expect(alert.notify.mock.calls[0][0]).toContain('Operator permanently unavailable')

    // The recovery query still runs, but its own attempts<MAX_ATTEMPTS filter means a
    // fulfillment at the ceiling is never included there, hence fulfillByPaymentIntentId
    // is never invoked for it (nothing in prisma.order.findMany's default empty mock
    // return value triggers a call at all).
    expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()

    const alertCutoffDelta = Date.now() - args.where.updatedAt.gte.getTime()
    expect(alertCutoffDelta).toBeGreaterThanOrEqual(ALERT_WINDOW_MS - 1000)
    expect(alertCutoffDelta).toBeLessThanOrEqual(ALERT_WINDOW_MS + 5000)
  })

  it('a per-order exception during recovery does not abort the loop — remaining orders still get processed', async () => {
    prisma.order.findMany.mockResolvedValue([
      { id: 'order-a', paymentIntentId: 'pi_a' },
      { id: 'order-b', paymentIntentId: 'pi_b' },
      { id: 'order-c', paymentIntentId: 'pi_c' },
    ])
    fulfillment.fulfillByPaymentIntentId.mockImplementation(async (paymentIntentId: string) => {
      if (paymentIntentId === 'pi_b') {
        throw new FulfillmentError('boom', 500, { retryable: false })
      }
      return { status: 'fulfilled' as const }
    })

    await service.reconcile()

    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledTimes(3)
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenNthCalledWith(1, 'pi_a')
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenNthCalledWith(2, 'pi_b')
    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenNthCalledWith(3, 'pi_c')
  })

  it('an exception thrown while reclaiming stale PROCESSING rows does not prevent recovery or alerting from running', async () => {
    prisma.fulfillment.updateMany.mockRejectedValue(new Error('db blip'))
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1', paymentIntentId: 'pi_1' }])
    prisma.fulfillment.findMany.mockResolvedValue([
      {
        orderId: 'order-2',
        attempts: MAX_ATTEMPTS,
        lastError: 'dead',
        status: 'FAILED',
        order: { id: 'order-2', paymentIntentId: 'pi_2' },
      },
    ])

    await expect(service.reconcile()).resolves.toBeUndefined()

    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith('pi_1')
    expect(alert.notify).toHaveBeenCalledTimes(1)
  })

  it('an exception thrown while querying for alerts does not prevent recovery from having already run', async () => {
    prisma.order.findMany.mockResolvedValue([{ id: 'order-1', paymentIntentId: 'pi_1' }])
    prisma.fulfillment.findMany.mockRejectedValue(new Error('db blip'))

    await expect(service.reconcile()).resolves.toBeUndefined()

    expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith('pi_1')
  })

  it('a failure sending one alert does not stop other alerts from being attempted', async () => {
    prisma.fulfillment.findMany.mockResolvedValue([
      { orderId: 'order-2', attempts: MAX_ATTEMPTS, lastError: 'dead-1', status: 'FAILED', order: { id: 'order-2', paymentIntentId: 'pi_2' } },
      { orderId: 'order-3', attempts: MAX_ATTEMPTS, lastError: 'dead-2', status: 'FAILED', order: { id: 'order-3', paymentIntentId: 'pi_3' } },
    ])
    alert.notify.mockRejectedValueOnce(new Error('mailgun down')).mockResolvedValueOnce(undefined)

    await service.reconcile()

    expect(alert.notify).toHaveBeenCalledTimes(2)
  })
})
