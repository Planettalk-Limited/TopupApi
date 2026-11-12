// Issues the campaign's reward voucher for an approved submission — an admin action, with
// no Stripe charge.
//
// Why not FulfillmentService.fulfillByPaymentIntentId: that path is built around a paid
// Stripe PaymentIntent (it retrieves the intent, re-prices the order against what was
// received, checks our HMAC binding and captures the hold). A reward has no intent, so it
// reuses the pieces that are not Stripe-specific instead — the same Order + Fulfillment
// rows, the same claim-before-execute ordering, the buhibab voucher executor and the
// voucher delivery email — without needing the free-order work on another branch.
//
// The order is created already claimed (Order PAID, Fulfillment PROCESSING) in one
// transaction, so the reconciliation worker never tries to "recover" it through Stripe:
// it only ever alerts on a stale PROCESSING row. A failure exhausts attempts and marks the
// order FAILED, so it is never retried automatically either (a voucher purchase whose
// outcome is unknown must not be bought twice).
import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AlertService } from '../common/alert.service'
import { CustomerEmailService } from '../common/customer-email.service'
import { PlanetTalkVoucherExecutor } from '../payments/executors/planettalk-voucher.executor'
import { MAX_ATTEMPTS } from '../payments/fulfillment.constants'
import { voucherProductName } from '../payments/voucher-order'
import type { VoucherFulfillmentOrder } from '../payments/payments.types'
import { VoucherService } from '../providers/buhibab/voucher.service'
import type { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { GiftEntitlementService } from './gift-entitlement.service'
import { GIFT_VOUCHER_ORDER_PREFIX } from './gift-eligibility'

/** Statuses from which a voucher may be issued. */
export const ISSUABLE_STATUSES = ['APPROVED', 'RECIPIENT_CONTACTED'] as const

@Injectable()
export class GiftVoucherIssuerService {
  private readonly logger = new Logger(GiftVoucherIssuerService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly executor: PlanetTalkVoucherExecutor,
    private readonly vouchers: VoucherService,
    private readonly alert: AlertService,
    private readonly email: CustomerEmailService,
    private readonly entitlements: GiftEntitlementService,
  ) {}

  async issue(submissionId: string, admin: AuthenticatedAdmin, opts: { productId?: number; amountNgn?: number } = {}) {
    const config = this.entitlements.config()
    const submission = await this.prisma.giftCampaignSubmission.findUnique({ where: { id: submissionId } })
    if (!submission) throw new NotFoundException('Submission not found')
    if (!(ISSUABLE_STATUSES as readonly string[]).includes(submission.status)) {
      throw new ConflictException(`A voucher can only be issued for an approved submission (this one is ${submission.status})`)
    }
    if (submission.voucherOrderId) {
      throw new ConflictException('A voucher order already exists for this submission; check it before issuing another')
    }

    const productId = opts.productId ?? config.voucherProductId
    if (!productId) {
      throw new ServiceUnavailableException('No voucher product configured (GIFT_CAMPAIGN_VOUCHER_PRODUCT_ID)')
    }
    const amountNgn = Math.round(opts.amountNgn ?? config.voucherAmountNgn)
    const deliverTo = submission.recipientEmail || config.fulfilmentEmail
    if (!deliverTo) {
      throw new BadRequestException(
        'The recipient gave no email and GIFT_CAMPAIGN_FULFILMENT_EMAIL is not set; buhibab requires an email on every voucher purchase',
      )
    }

    const product = await this.vouchers.findVoucher(productId)
    if (!product) throw new BadRequestException(`Voucher product ${productId} is not in the buhibab catalogue`)
    if (amountNgn < product.minAmount || amountNgn > product.maxAmount) {
      throw new BadRequestException(
        `NGN ${amountNgn} is outside ${product.name}'s range (NGN ${product.minAmount}-${product.maxAmount})`,
      )
    }
    const productName = voucherProductName(product.name)

    // Attempt number in the intent id keeps it unique if a definitely-failed purchase is retried.
    const attempt =
      (await this.prisma.giftCampaignEvent.count({ where: { submissionId, type: 'VOUCHER_ISSUE_FAILED' } })) + 1
    const paymentIntentId = `${GIFT_VOUCHER_ORDER_PREFIX}${submission.id}_${attempt}`

    // Claim: order + PROCESSING fulfilment + link to the submission, atomically. The guarded
    // update means two admins clicking at once cannot both buy a voucher.
    const orderId = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const order = await tx.order.create({
        data: {
          paymentIntentId,
          productType: 'VOUCHER',
          provider: 'PLANETTALK',
          countryCode: 'NG',
          recipientPhone: submission.recipientPhone,
          recipientEmail: submission.recipientEmail,
          productId: String(productId),
          productName,
          providerAmount: amountNgn,
          providerCurrency: 'NGN',
          chargeAmount: 0,
          chargeCurrency: 'GBP',
          status: 'PAID',
          details: { source: 'gift-campaign', submissionId: submission.id, reference: submission.reference, issuedBy: admin.id },
          fulfillment: { create: { status: 'PROCESSING', processingClaimedAt: new Date(), attempts: 1 } },
        },
      })
      const linked = await tx.giftCampaignSubmission.updateMany({
        where: { id: submission.id, voucherOrderId: null, status: { in: [...ISSUABLE_STATUSES] } },
        data: { voucherOrderId: order.id },
      })
      if (linked.count !== 1) throw new ConflictException('This submission changed while issuing; reload and try again')
      return order.id
    })

    const order: VoucherFulfillmentOrder = {
      productType: 'voucher',
      countryCode: 'NG',
      providerAmount: amountNgn,
      providerCurrency: 'NGN',
      productName,
      productId,
      email: deliverTo,
      ...(submission.recipientEmail ? { recipientEmail: submission.recipientEmail } : {}),
    }

    let result: Awaited<ReturnType<PlanetTalkVoucherExecutor['execute']>>
    try {
      result = await this.executor.execute(order, paymentIntentId, orderId)
    } catch (err) {
      const message = String((err as Error)?.message ?? err).slice(0, 500)
      // exhaustAttempts = buhibab may have issued it: keep the order linked so nobody re-buys
      // before checking. Otherwise nothing was bought, so unlink and allow a later retry.
      const outcomeUnknown = (err as { exhaustAttempts?: boolean })?.exhaustAttempts === true
      await this.prisma.fulfillment.update({
        where: { orderId },
        data: { status: 'FAILED', lastError: message, attempts: MAX_ATTEMPTS },
      })
      await this.prisma.order.update({ where: { id: orderId }, data: { status: 'FAILED' } })
      await this.prisma.providerCallLog.create({
        data: { orderId, provider: 'PLANETTALK', endpoint: '/products/purchase', method: 'POST', success: false, error: message.slice(0, 300) },
      })
      await this.prisma.giftCampaignSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'ESCALATED',
          reasonCode: 'VOUCHER_ISSUE_FAILED',
          reasonNote: message,
          ...(outcomeUnknown ? {} : { voucherOrderId: null }),
        },
      })
      await this.prisma.giftCampaignEvent.createMany({
        data: [
          { submissionId: submission.id, type: 'VOUCHER_ISSUE_FAILED', note: message, actorType: 'ADMIN', adminId: admin.id },
          {
            submissionId: submission.id,
            type: 'STATUS_CHANGED',
            fromStatus: submission.status,
            toStatus: 'ESCALATED',
            reasonCode: 'VOUCHER_ISSUE_FAILED',
            actorType: 'SYSTEM',
          },
        ],
      })
      await this.alert.notify(
        `Gift campaign voucher for ${submission.reference} failed (${outcomeUnknown ? 'outcome unknown - check buhibab before retrying' : 'nothing bought'}): ${message}`,
        outcomeUnknown ? 'critical' : 'warning',
      )
      throw new ServiceUnavailableException(`Voucher was not issued: ${message}`)
    }

    // Success. The code/PIN live only in Fulfillment.meta, never in events or notes.
    const reference = String(result.transaction.referenceId ?? result.transaction.transactionId)
    await this.prisma.fulfillment.update({
      where: { orderId },
      data: {
        status: 'FULFILLED',
        providerTransactionId: String(result.transaction.transactionId),
        fulfilledAt: new Date(),
        meta: {
          ...((result.transaction.meta ?? {}) as Record<string, Prisma.InputJsonValue>),
          cardCode: result.giftCard.cardCode,
          ...(result.giftCard.cardPin ? { cardPin: result.giftCard.cardPin } : {}),
          vouchers: result.vouchers as unknown as Prisma.InputJsonValue,
        },
      },
    })
    await this.prisma.order.update({ where: { id: orderId }, data: { status: 'FULFILLED' } })
    await this.prisma.providerCallLog.create({
      data: { orderId, provider: 'PLANETTALK', endpoint: '/products/purchase', method: 'POST', success: true, responseStatus: 200 },
    })
    await this.prisma.giftCampaignSubmission.update({
      where: { id: submission.id },
      data: { status: 'AWAITING_REDEMPTION', voucherReference: reference, voucherIssuedAt: new Date(), reasonCode: null, reasonNote: null },
    })
    const events: Prisma.GiftCampaignEventCreateManyInput[] = [
      {
        submissionId: submission.id,
        type: 'VOUCHER_ISSUED',
        note: `${productName}, NGN ${amountNgn}, buhibab ref ${reference}`,
        actorType: 'ADMIN',
        adminId: admin.id,
      },
      {
        submissionId: submission.id,
        type: 'STATUS_CHANGED',
        fromStatus: submission.status,
        toStatus: 'AWAITING_REDEMPTION',
        actorType: 'SYSTEM',
      },
    ]

    // Hand the voucher to the recipient by email when they gave one. Otherwise ops relays it
    // through the approved contact channel (from the restricted voucher view).
    let delivered: boolean | null = null
    if (submission.recipientEmail) {
      delivered = await this.email.sendVoucherDelivery({
        to: submission.recipientEmail,
        productName,
        vouchers: result.vouchers,
        faceValue: amountNgn,
        reference,
      })
      events.push({
        submissionId: submission.id,
        type: delivered ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED',
        channel: 'email',
        note: 'voucher_delivery_to_recipient',
        actorType: 'SYSTEM',
      })
      if (!delivered) {
        await this.alert.notify(
          `Gift campaign voucher for ${submission.reference} was issued but the email to the recipient failed. Relay it by hand.`,
          'warning',
        )
      }
    }
    await this.prisma.giftCampaignEvent.createMany({ data: events })
    await this.prisma.adminAuditLog
      .create({ data: { adminId: admin.id, action: 'gift_issue_voucher', target: submission.reference, result: 'success' } })
      .catch(() => undefined)

    return { status: 'AWAITING_REDEMPTION' as const, orderId, voucherReference: reference, emailedToRecipient: delivered }
  }
}
