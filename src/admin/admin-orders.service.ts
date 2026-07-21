import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { ListOrdersDto } from './dto/list-orders.dto'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

@Injectable()
export class AdminOrdersService {
  constructor(private readonly prisma: PrismaService) {}

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
      data: orders,
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
    return order
  }

  /**
   * Phase 1 stub. Records the admin's intent in the audit log and returns a
   * not-yet-implemented marker. Phase 4 wires this to the fulfillment
   * orchestrator (SELECT ... FOR UPDATE claim → provider call).
   */
  async retry(paymentIntentId: string, admin: AuthenticatedAdmin) {
    const order = await this.prisma.order.findUnique({ where: { paymentIntentId } })
    if (!order) throw new NotFoundException('Order not found')

    await this.prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        action: 'retry_fulfillment',
        target: paymentIntentId,
        result: 'not_implemented_phase1',
      },
    })

    return {
      ok: false,
      pending: true,
      message: 'Retry is not available until the fulfillment engine migrates (Phase 4).',
    }
  }
}
