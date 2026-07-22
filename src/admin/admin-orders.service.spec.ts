import { HttpException, NotFoundException } from '@nestjs/common'
import { AdminOrdersService } from './admin-orders.service'
import { FulfillmentError } from '../payments/fulfillment.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

const PAYMENT_INTENT_ID = 'pi_test_123'

const admin: AuthenticatedAdmin = {
  id: 'admin-1',
  email: 'admin@example.com',
  name: 'Admin',
  role: 'ADMIN' as AuthenticatedAdmin['role'],
}

function buildOrderRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'order-row-1',
    paymentIntentId: PAYMENT_INTENT_ID,
    status: 'FAILED',
    ...overrides,
  }
}

function buildFulfillmentRow(overrides: Partial<Record<string, any>> = {}) {
  return {
    id: 'fulfillment-1',
    orderId: 'order-row-1',
    status: 'FULFILLED',
    providerTransactionId: 'txn_1',
    meta: { cardCode: '1234567890123456', cardPin: '9876' },
    ...overrides,
  }
}

describe('AdminOrdersService', () => {
  let prisma: {
    order: { findUnique: jest.Mock; count: jest.Mock; findMany: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let fulfillment: { fulfillByPaymentIntentId: jest.Mock }
  let service: AdminOrdersService

  beforeEach(() => {
    prisma = {
      order: {
        findUnique: jest.fn(),
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    fulfillment = { fulfillByPaymentIntentId: jest.fn() }

    service = new AdminOrdersService(prisma as any, fulfillment as any)
  })

  describe('retry', () => {
    it('throws NotFoundException when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null)

      await expect(service.retry(PAYMENT_INTENT_ID, admin)).rejects.toBeInstanceOf(NotFoundException)
      expect(fulfillment.fulfillByPaymentIntentId).not.toHaveBeenCalled()
    })

    it('calls FulfillmentService and audits success with the outcome status', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockResolvedValue({ status: 'fulfilled' })

      const result = await service.retry(PAYMENT_INTENT_ID, admin)

      expect(fulfillment.fulfillByPaymentIntentId).toHaveBeenCalledWith(PAYMENT_INTENT_ID)
      expect(result).toEqual({ ok: true, status: 'fulfilled' })
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: PAYMENT_INTENT_ID,
          result: 'fulfilled',
        },
      })
    })

    it('audits "already" when the engine reports the order was already claimed/fulfilled', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockResolvedValue({ status: 'already' })

      const result = await service.retry(PAYMENT_INTENT_ID, admin)

      expect(result).toEqual({ ok: true, status: 'already' })
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: PAYMENT_INTENT_ID,
          result: 'already',
        },
      })
    })

    it('records the message and rethrows a mapped HttpException on FulfillmentError', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
        new FulfillmentError('Amount paid does not cover this order', 402),
      )

      const promise = service.retry(PAYMENT_INTENT_ID, admin)

      await expect(promise).rejects.toBeInstanceOf(HttpException)
      await expect(promise).rejects.toMatchObject({
        message: 'Amount paid does not cover this order',
        status: 402,
      })

      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: PAYMENT_INTENT_ID,
          result: 'failed: Amount paid does not cover this order',
        },
      })
    })

    it('maps a non-FulfillmentError failure to a 500 HttpException and still audits', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockRejectedValue(new Error('boom'))

      const promise = service.retry(PAYMENT_INTENT_ID, admin)

      await expect(promise).rejects.toBeInstanceOf(HttpException)
      await expect(promise).rejects.toMatchObject({ message: 'boom', status: 500 })
      expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: PAYMENT_INTENT_ID,
          result: 'failed: boom',
        },
      })
    })

    it('still rethrows the original FulfillmentError when the audit-log write itself fails', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockRejectedValue(
        new FulfillmentError('Amount paid does not cover this order', 402),
      )
      prisma.adminAuditLog.create.mockRejectedValue(new Error('db unavailable'))

      const promise = service.retry(PAYMENT_INTENT_ID, admin)

      await expect(promise).rejects.toBeInstanceOf(HttpException)
      await expect(promise).rejects.toMatchObject({
        message: 'Amount paid does not cover this order',
        status: 402,
      })
    })

    it('still rethrows a mapped 500 for a non-FulfillmentError failure when the audit-log write itself fails', async () => {
      prisma.order.findUnique.mockResolvedValue(buildOrderRow())
      fulfillment.fulfillByPaymentIntentId.mockRejectedValue(new Error('boom'))
      prisma.adminAuditLog.create.mockRejectedValue(new Error('db unavailable'))

      const promise = service.retry(PAYMENT_INTENT_ID, admin)

      await expect(promise).rejects.toBeInstanceOf(HttpException)
      await expect(promise).rejects.toMatchObject({ message: 'boom', status: 500 })
    })
  })

  describe('meta redaction', () => {
    it('masks cardPin entirely and cardCode down to the last 4 chars in list()', async () => {
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-row-1', fulfillment: buildFulfillmentRow() },
      ])
      prisma.order.count.mockResolvedValue(1)

      const result = await service.list({} as any)

      expect(result.data[0].fulfillment!.meta).toEqual({
        cardCode: '••••3456',
        cardPin: '••••',
      })
    })

    it('masks cardPin/cardCode in getByPaymentIntentId()', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-row-1',
        paymentIntentId: PAYMENT_INTENT_ID,
        fulfillment: buildFulfillmentRow(),
        providerCallLogs: [],
      })

      const result = await service.getByPaymentIntentId(PAYMENT_INTENT_ID)

      expect(result.fulfillment!.meta).toEqual({
        cardCode: '••••3456',
        cardPin: '••••',
      })
    })

    it('leaves non-sensitive meta (e.g. electricity units) untouched', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-row-1',
        paymentIntentId: PAYMENT_INTENT_ID,
        fulfillment: buildFulfillmentRow({ meta: { token: 'ABC123', units: '42kWh' } }),
        providerCallLogs: [],
      })

      const result = await service.getByPaymentIntentId(PAYMENT_INTENT_ID)

      expect(result.fulfillment!.meta).toEqual({ token: 'ABC123', units: '42kWh' })
    })

    it('handles a null fulfillment (order not yet fulfilled) without throwing', async () => {
      prisma.order.findUnique.mockResolvedValue({
        id: 'order-row-1',
        paymentIntentId: PAYMENT_INTENT_ID,
        fulfillment: null,
        providerCallLogs: [],
      })

      const result = await service.getByPaymentIntentId(PAYMENT_INTENT_ID)

      expect(result.fulfillment).toBeNull()
    })

    it('throws NotFoundException from getByPaymentIntentId when the order does not exist', async () => {
      prisma.order.findUnique.mockResolvedValue(null)

      await expect(service.getByPaymentIntentId(PAYMENT_INTENT_ID)).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })
  })
})
