import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { ListOrdersDto } from './dto/list-orders.dto'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { FulfillmentError, FulfillmentService } from '../payments/fulfillment.service'

// SECURITY: Fulfillment.meta carries plaintext provider secrets (gift-card
// cardCode/cardPin, redemption URLs) that the admin console must never render
// verbatim. Mask cardPin entirely and cardCode down to its last 4 characters;
// everything else (e.g. electricity token/units) is not sensitive in the same
// way and stays visible. Applied at the service boundary so every read path
// (list + detail) is covered by construction.
function redactFulfillmentMeta(meta: Prisma.JsonValue | null | undefined): Prisma.JsonValue | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return meta ?? null
  }

  const redacted: Record<string, unknown> = { ...(meta as Record<string, unknown>) }

  if (typeof redacted.cardPin === 'string' && redacted.cardPin.length > 0) {
    redacted.cardPin = '••••'
  }

  if (typeof redacted.cardCode === 'string' && redacted.cardCode.length > 0) {
    const code = redacted.cardCode
    redacted.cardCode = code.length <= 4 ? '••••' : `••••${code.slice(-4)}`
  }

  return redacted as Prisma.JsonValue
}

function redactFulfillment<T extends { meta: Prisma.JsonValue | null } | null>(
  fulfillment: T,
): T {
  if (!fulfillment) return fulfillment
  return { ...fulfillment, meta: redactFulfillmentMeta(fulfillment.meta) }
}

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
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

      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'retry_fulfillment',
          target: paymentIntentId,
          result: `failed: ${message}`.slice(0, 500),
        },
      })

      throw new HttpException(message, statusCode)
    }
  }
}
