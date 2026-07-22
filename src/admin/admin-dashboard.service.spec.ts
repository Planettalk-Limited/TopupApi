import { AdminDashboardService } from './admin-dashboard.service'

function buildPrisma(recentOrders: unknown[]) {
  return {
    order: {
      count: jest.fn().mockResolvedValue(0),
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue(recentOrders),
    },
    fulfillment: {
      count: jest.fn().mockResolvedValue(0),
    },
    creditbackClaim: {
      groupBy: jest.fn().mockResolvedValue([]),
    },
    providerCallLog: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  }
}

describe('AdminDashboardService', () => {
  describe('meta redaction', () => {
    it('masks cardPin entirely and cardCode down to the last 4 chars in recentOrders', async () => {
      const prisma = buildPrisma([
        {
          id: 'order-row-1',
          fulfillment: {
            id: 'fulfillment-1',
            status: 'FULFILLED',
            providerTransactionId: 'txn_1',
            meta: { cardCode: '1234567890123456', cardPin: '9876' },
          },
        },
      ])
      const service = new AdminDashboardService(prisma as any)

      const result = await service.summary()

      expect(result.recentOrders[0].fulfillment!.meta).toEqual({
        cardCode: '••••3456',
        cardPin: '••••',
      })
    })

    it('leaves non-sensitive meta (e.g. electricity units) untouched', async () => {
      const prisma = buildPrisma([
        {
          id: 'order-row-1',
          fulfillment: {
            id: 'fulfillment-1',
            status: 'FULFILLED',
            providerTransactionId: 'txn_1',
            meta: { token: 'ABC123', units: '42kWh' },
          },
        },
      ])
      const service = new AdminDashboardService(prisma as any)

      const result = await service.summary()

      expect(result.recentOrders[0].fulfillment!.meta).toEqual({ token: 'ABC123', units: '42kWh' })
    })

    it('handles a null fulfillment (order not yet fulfilled) without throwing', async () => {
      const prisma = buildPrisma([{ id: 'order-row-1', fulfillment: null }])
      const service = new AdminDashboardService(prisma as any)

      const result = await service.summary()

      expect(result.recentOrders[0].fulfillment).toBeNull()
    })
  })
})
