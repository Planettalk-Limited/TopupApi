import { HttpException, Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { redactFulfillment } from '../common/redact-fulfillment'
import { ListOrdersDto } from './dto/list-orders.dto'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { FulfillmentError, FulfillmentService } from '../payments/fulfillment.service'
import { StripeService } from '../payments/stripe.service'
import { AlertService } from '../common/alert.service'
import { auditExport, capRows, CsvColumn, EXPORT_TAKE, toCsv } from './csv-export'

type OrderFilters = Pick<ListOrdersDto, 'status' | 'productType' | 'provider' | 'search' | 'from' | 'to'>

const ORDER_EXPORT_SELECT = {
  createdAt: true,
  paymentIntentId: true,
  status: true,
  productType: true,
  provider: true,
  countryCode: true,
  productName: true,
  operatorId: true,
  productId: true,
  billerId: true,
  recipientPhone: true,
  recipientEmail: true,
  accountNumber: true,
  providerAmount: true,
  providerCurrency: true,
  subtotalAmount: true,
  discountAmount: true,
  chargeAmount: true,
  chargeCurrency: true,
  refunded: true,
  disputed: true,
  customer: { select: { email: true } },
  promoCode: { select: { code: true } },
  fulfillment: {
    select: { status: true, providerTransactionId: true, attempts: true, lastError: true, fulfilledAt: true },
  },
} satisfies Prisma.OrderSelect

const ORDER_EXPORT_COLUMNS: CsvColumn<Prisma.OrderGetPayload<{ select: typeof ORDER_EXPORT_SELECT }>>[] = [
  ['createdAt', (o) => o.createdAt],
  ['paymentIntentId', (o) => o.paymentIntentId],
  ['status', (o) => o.status],
  ['fulfillmentStatus', (o) => o.fulfillment?.status],
  ['productType', (o) => o.productType],
  ['provider', (o) => o.provider],
  ['countryCode', (o) => o.countryCode],
  ['productName', (o) => o.productName],
  ['operatorId', (o) => o.operatorId],
  ['productId', (o) => o.productId],
  ['billerId', (o) => o.billerId],
  ['recipientPhone', (o) => o.recipientPhone],
  ['recipientEmail', (o) => o.recipientEmail],
  ['accountNumber', (o) => o.accountNumber],
  ['providerAmount', (o) => o.providerAmount],
  ['providerCurrency', (o) => o.providerCurrency],
  ['subtotalAmount', (o) => o.subtotalAmount],
  ['discountAmount', (o) => o.discountAmount],
  ['chargeAmount', (o) => o.chargeAmount],
  ['chargeCurrency', (o) => o.chargeCurrency],
  ['promoCode', (o) => o.promoCode?.code],
  ['customerEmail', (o) => o.customer?.email],
  ['refunded', (o) => o.refunded],
  ['disputed', (o) => o.disputed],
  ['providerTransactionId', (o) => o.fulfillment?.providerTransactionId],
  ['attempts', (o) => o.fulfillment?.attempts],
  ['lastError', (o) => o.fulfillment?.lastError],
  ['fulfilledAt', (o) => o.fulfillment?.fulfilledAt],
]

@Injectable()
export class AdminOrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
    private readonly stripe: StripeService,
    private readonly alert: AlertService,
  ) {}

  /** Best-effort audit write — a DB hiccup here must never mask the real outcome. */
  private async safeAudit(adminId: string, target: string, result: string) {
    try {
      await this.prisma.adminAuditLog.create({
        data: { adminId, action: 'refund', target, result: result.slice(0, 500) },
      })
    } catch {
      // swallow — audit logging is best-effort, not the source of truth
    }
  }

  private where(query: OrderFilters): Prisma.OrderWhereInput {
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
    return where
  }

  async list(query: ListOrdersDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const where = this.where(query)

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

  /**
   * Every matching order as CSV, same filters as the list. Fulfilment `meta` (gift-card
   * codes/PINs) and `details` (healthcare patient data) are deliberately not columns.
   */
  async exportCsv(query: OrderFilters, admin: AuthenticatedAdmin): Promise<string> {
    const orders = capRows(
      await this.prisma.order.findMany({
        where: this.where(query),
        select: ORDER_EXPORT_SELECT,
        orderBy: { createdAt: 'desc' },
        take: EXPORT_TAKE,
      }),
    )
    const { status, productType, provider, search, from, to } = query
    await auditExport(this.prisma, admin, 'export_orders', orders.length, { status, productType, provider, search, from, to })
    return toCsv(ORDER_EXPORT_COLUMNS, orders)
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

    // Atomic claim: only the request that flips refunded false->true proceeds to
    // Stripe. This makes the app (not Stripe's charge-amount invariant) the source
    // of truth against a concurrent double-refund, and closes the redeem-after-refund
    // window (the gift-card-code endpoint checks `refunded`) for the duration of the call.
    const claim = await this.prisma.order.updateMany({
      where: { paymentIntentId, refunded: false },
      data: { refunded: true },
    })
    if (claim.count === 0) {
      await this.safeAudit(admin.id, paymentIntentId, 'already_refunded')
      return { ok: true, alreadyRefunded: true }
    }

    let refund: { id: string; status: string | null }
    try {
      // Under manual capture an order may still be sitting on an AUTHORISATION. Stripe
      // cannot refund money it never captured — giving it back is a cancel, which
      // releases the hold. Ask what state the intent is in rather than assuming.
      const intent = await this.stripe.client.paymentIntents.retrieve(paymentIntentId)

      if (intent.status === 'requires_capture') {
        const canceled = await this.stripe.client.paymentIntents.cancel(paymentIntentId)
        refund = { id: canceled.id, status: canceled.status ?? 'canceled' }
      } else {
        refund = await this.stripe.client.refunds.create({ payment_intent: paymentIntentId })
      }
    } catch (err) {
      // The Stripe call itself failed → no money moved → revert the claim so it can be
      // retried. (Edge: if Stripe throws `charge_already_refunded` — an out-of-band refund
      // we hadn't recorded — the revert sets refunded=false, but the charge.refunded webhook
      // re-sets it; self-healing.)
      const message = err instanceof Error ? err.message : String(err)
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 502
      await this.prisma.order.updateMany({
        where: { paymentIntentId, refunded: true },
        data: { refunded: false },
      })
      await this.safeAudit(admin.id, paymentIntentId, `failed:${message}`)
      throw new HttpException(message, statusCode)
    }

    // Stripe succeeded — money has moved and `refunded` is already true (claimed above).
    // A failure recording the audit here must NOT revert the flag or report failure to the
    // caller; surface the inconsistency via an alert instead.
    try {
      await this.prisma.adminAuditLog.create({
        data: {
          adminId: admin.id,
          action: 'refund',
          target: paymentIntentId,
          result: `refunded:${refund.id}`,
        },
      })
    } catch (e) {
      await this.alert.notify(
        `Refund ${refund.id} for ${paymentIntentId} succeeded at Stripe but the audit write failed: ${e instanceof Error ? e.message : String(e)}`,
        'critical',
      )
    }

    return { ok: true, refundId: refund.id, status: refund.status }
  }
}
