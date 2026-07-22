import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { redactFulfillment } from '../common/redact-fulfillment'
import { ListOrdersDto } from './dto/list-orders.dto'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { FulfillmentError, FulfillmentService } from '../payments/fulfillment.service'
import { StripeService } from '../payments/stripe.service'

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
    private readonly stripe: StripeService,
  ) {}

  async list(query: ListOrdersDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const where: Prisma.OrderWhereInput = {}
    if (query.status) where.status = query.status
    if (query.productType) where.productType = query.productType
    if (query.provider) where.provider = query.provider

    if (query.from || query.to) {
      where.createdAt = {}
      if (query.from) where.createdAt.gte = new Date(query.from)
      if (query.to) where.createdAt.lte = new Date(query.to)
    }

    const search = query.search?.trim()
    if (search) {
      where.OR = [
        { paymentIntentId: { contains: search, mode: 'insensitive' } },
        { recipientPhone: { contains: search, mode: 'insensitive' } },
        { recipientEmail: { contains: search, mode: 'insensitive' } },
        { productName: { contains: search, mode: 'insensitive' } },
        { accountNumber: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [total, orders] = await Promise.all([
      this.prisma.order.count({ where }),
      this.prisma.order.findMany({
        where,
        include: { fulfillment: true },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return {
      data: orders.map((order) => ({
        ...order,
        fulfillment: redactFulfillment(order.fulfillment),
      })),
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  async getByPaymentIntentId(paymentIntentId: string) {
    const order = await this.prisma.order.findUnique({
      where: { paymentIntentId },
      include: {
        fulfillment: true,
        providerCallLogs: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!order) throw new NotFoundException('Order not found')

    return {
      ...order,
      fulfillment: redactFulfillment(order.fulfillment),
    }
  }

  /**
   * Re-runs fulfilment through the same claim/execute/record orchestrator the
   * webhook uses (`FulfillmentService.fulfillByPaymentIntentId`). The
   * orchestrator re-claims FAILED (and PENDING) rows, so this is how a stuck
   * FAILED order gets a genuine retry rather than a stubbed response.
   */
  async retry(paymentIntentId: string, admin: AuthenticatedAdmin) {
    const order = await this.prisma.order.findUnique({ where: { paymentIntentId } })
    if (!order) throw new NotFoundException('Order not found')

    try {
      const outcome = await this.fulfillment.fulfillByPaymentIntentId(paymentIntentId)

      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: paymentIntentId,
          result: outcome.status, // 'fulfilled' | 'already' | 'skipped'
        },
      })

      return { ok: true, status: outcome.status }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const statusCode = err instanceof FulfillmentError ? err.statusCode : 500

      // Best-effort audit write: a DB hiccup here must never mask/replace the
      // original FulfillmentError being rethrown below.
      try {
        await this.prisma.adminAuditLog.create({
          data: {
            adminId: admin.id,
            action: 'retry_fulfillment',
            target: paymentIntentId,
            result: `failed: ${message}`.slice(0, 500),
          },
        })
      } catch {
        // swallow — audit logging is best-effort, not the source of truth for this response
      }

      throw new HttpException(message, statusCode)
    }
  }

  /**
   * Issues a Stripe refund for the order's PaymentIntent and flags the order
   * as refunded. Idempotent: if the order is already marked refunded, we do
   * NOT call Stripe again (a second refund attempt on an already-refunded
   * charge fails with a Stripe error, and could otherwise be raced into a
   * double refund) — we short-circuit and audit `already_refunded`.
   *
   * Setting `order.refunded = true` also blocks the gift-card-code endpoint
   * (payments.controller.ts already checks `refunded` before returning the
   * redeemable code), so a refunded order's code is no longer retrievable.
   */
  async refund(paymentIntentId: string, admin: AuthenticatedAdmin) {
    const order = await this.prisma.order.findUnique({ where: { paymentIntentId } })
    if (!order) throw new NotFoundException('Order not found')

    if (order.refunded) {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'refund',
          target: paymentIntentId,
          result: 'already_refunded',
        },
      })
      return { ok: true, alreadyRefunded: true }
    }

    try {
      const refund = await this.stripe.client.refunds.create({ payment_intent: paymentIntentId })

      await this.prisma.order.update({
        where: { paymentIntentId },
        data: { refunded: true },
      })

      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'refund',
          target: paymentIntentId,
          result: `refunded:${refund.id}`,
        },
      })

      return { ok: true, refundId: refund.id, status: refund.status }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 502

      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'refund',
          target: paymentIntentId,
          result: `failed:${message}`.slice(0, 500),
        },
      })

      throw new HttpException(message, statusCode)
    }
  }
}
