import { Injectable } from '@nestjs/common'
import { CreditbackClaimStatus, FulfillmentStatus, OrderStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { redactFulfillment } from '../common/redact-fulfillment'

/**
 * Aggregates for the admin dashboard landing page. All read-only counts /
 * sums — cheap enough to compute on request; no caching layer yet.
 */
@Injectable()
export class AdminDashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async summary() {
    const now = Date.now()
    const since24h = new Date(now - 24 * 60 * 60 * 1000)
    const startOfToday = new Date()
    startOfToday.setHours(0, 0, 0, 0)

    const [
      totalOrders,
      ordersByStatus,
      ordersToday,
      revenueByCurrency,
      pendingFulfillments,
      failedFulfillments,
      creditbackByStatus,
      recentOrders,
      providerCalls24h,
    ] = await Promise.all([
      this.prisma.order.count(),
      this.prisma.order.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.count({ where: { createdAt: { gte: startOfToday } } }),
      this.prisma.order.groupBy({
        by: ['chargeCurrency'],
        where: { status: OrderStatus.FULFILLED },
        _sum: { chargeAmount: true },
        _count: { _all: true },
      }),
      this.prisma.fulfillment.count({
        where: { status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.PROCESSING] } },
      }),
      this.prisma.fulfillment.count({ where: { status: FulfillmentStatus.FAILED } }),
      this.prisma.creditbackClaim.groupBy({ by: ['status'], _count: { _all: true } }),
      this.prisma.order.findMany({
        take: 8,
        orderBy: { createdAt: 'desc' },
        include: { fulfillment: true },
      }),
      this.prisma.providerCallLog.findMany({
        where: { createdAt: { gte: since24h } },
        select: { success: true, provider: true, latencyMs: true },
      }),
    ])

    // Fold groupBy results into simple keyed maps the UI can read directly.
    const statusCounts = Object.fromEntries(
      Object.values(OrderStatus).map((s) => [s, 0]),
    ) as Record<OrderStatus, number>
    for (const row of ordersByStatus) statusCounts[row.status] = row._count._all

    const creditbackCounts = Object.fromEntries(
      Object.values(CreditbackClaimStatus).map((s) => [s, 0]),
    ) as Record<CreditbackClaimStatus, number>
    for (const row of creditbackByStatus) creditbackCounts[row.status] = row._count._all

    const revenue = revenueByCurrency.map((r) => ({
      currency: r.chargeCurrency,
      total: r._sum.chargeAmount?.toString() ?? '0',
      orders: r._count._all,
    }))

    const callsTotal = providerCalls24h.length
    const callsOk = providerCalls24h.filter((c) => c.success).length
    const avgLatency =
      callsTotal > 0
        ? Math.round(
            providerCalls24h.reduce((sum, c) => sum + (c.latencyMs ?? 0), 0) / callsTotal,
          )
        : null

    return {
      orders: {
        total: totalOrders,
        today: ordersToday,
        byStatus: statusCounts,
      },
      fulfillment: {
        pending: pendingFulfillments,
        failed: failedFulfillments,
      },
      revenue,
      creditback: {
        total: Object.values(creditbackCounts).reduce((a, b) => a + b, 0),
        byStatus: creditbackCounts,
      },
      providerHealth24h: {
        calls: callsTotal,
        successRate: callsTotal > 0 ? Math.round((callsOk / callsTotal) * 100) : null,
        avgLatencyMs: avgLatency,
      },
      // SECURITY: never return raw fulfillment.meta here — see redact-fulfillment.ts.
      recentOrders: recentOrders.map((order) => ({
        ...order,
        fulfillment: redactFulfillment(order.fulfillment),
      })),
    }
  }
}
