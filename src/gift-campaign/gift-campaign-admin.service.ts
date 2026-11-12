// Operations view of the campaign: review queue, status workflow, contact log, export.
import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common'
import { Prisma, type GiftSubmissionStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CustomerEmailService } from '../common/customer-email.service'
import type { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { auditExport, capRows, EXPORT_TAKE, toCsv, type CsvColumn } from '../admin/csv-export'
import { GiftEntitlementService } from './gift-entitlement.service'
import {
  assertTransition,
  customerRejectionReason,
  GiftTransitionError,
  REASONS_BY_STATUS,
  SUBMISSION_STATUSES,
  TRANSITIONS,
} from './gift-status'
import type {
  AssignGiftDto,
  ContactAttemptDto,
  GiftNoteDto,
  ListGiftEntitlementsDto,
  ListGiftSubmissionsDto,
  TransitionGiftDto,
} from './dto/gift-campaign.dto'

type SubmissionRow = Prisma.GiftCampaignSubmissionGetPayload<{
  include: { assignedAdmin: { select: { id: true; name: true } }; entitlement: { select: { orderId: true } } }
}>

const LIST_INCLUDE = {
  assignedAdmin: { select: { id: true, name: true } },
  entitlement: { select: { orderId: true } },
} as const

const EXPORT_COLUMNS: CsvColumn<SubmissionRow>[] = [
  ['reference', (r) => r.reference],
  ['submissionId', (r) => r.id],
  ['status', (r) => r.status],
  ['reasonCode', (r) => r.reasonCode],
  ['eligibilityResult', (r) => r.eligibilityResult],
  ['flags', (r) => r.flags],
  ['qualifyingOrderId', (r) => r.entitlement?.orderId],
  ['senderName', (r) => r.senderName],
  ['senderEmail', (r) => r.senderEmail],
  ['senderPhone', (r) => r.senderPhone],
  ['recipientName', (r) => r.recipientName],
  ['recipientPhone', (r) => r.recipientPhone],
  ['recipientEmail', (r) => r.recipientEmail],
  ['relationship', (r) => r.relationship],
  ['preferredContact', (r) => r.preferredContact],
  ['termsVersion', (r) => r.termsVersion],
  ['termsAcceptedAt', (r) => r.termsAcceptedAt],
  ['assignedTo', (r) => r.assignedAdmin?.name],
  // The buhibab reference only — voucher codes/PINs are never exported.
  ['voucherReference', (r) => r.voucherReference],
  ['voucherIssuedAt', (r) => r.voucherIssuedAt],
  ['approvedAt', (r) => r.approvedAt],
  ['fulfilledAt', (r) => r.fulfilledAt],
  ['senderNotifiedAt', (r) => r.senderNotifiedAt],
  ['createdAt', (r) => r.createdAt],
  ['updatedAt', (r) => r.updatedAt],
]

/** Statuses that trigger a notification to the sender. */
type NotifyKind = 'approved' | 'rejected' | 'fulfilled'
const NOTIFY_ON: Partial<Record<GiftSubmissionStatus, NotifyKind>> = {
  APPROVED: 'approved',
  REJECTED: 'rejected',
  FULFILLED: 'fulfilled',
}

@Injectable()
export class GiftCampaignAdminService {
  private readonly logger = new Logger(GiftCampaignAdminService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: CustomerEmailService,
    private readonly entitlements: GiftEntitlementService,
  ) {}

  /** Effective config and workflow, for the console UI. No secrets. */
  overview() {
    const c = this.entitlements.config()
    return {
      config: {
        enabled: c.enabled,
        campaignKey: c.campaignKey,
        startsAt: c.startsAt,
        endsAt: c.endsAt,
        minTopupGbp: c.minTopupGbp,
        productTypes: c.productTypes,
        senderCountries: c.senderCountries,
        destinationCountries: c.destinationCountries,
        maxPerCustomer: c.maxPerCustomer,
        linkTtlDays: c.linkTtlDays,
        submissionGraceDays: c.submissionGraceDays,
        termsVersion: c.termsVersion,
        rewardGbp: c.rewardGbp,
        voucherProductId: c.voucherProductId,
        voucherAmountNgn: c.voucherAmountNgn,
        fulfilmentEmailConfigured: !!c.fulfilmentEmail,
      },
      statuses: SUBMISSION_STATUSES,
      transitions: TRANSITIONS,
      reasonCodes: REASONS_BY_STATUS,
    }
  }

  private where(q: ListGiftSubmissionsDto, admin?: AuthenticatedAdmin): Prisma.GiftCampaignSubmissionWhereInput {
    const where: Prisma.GiftCampaignSubmissionWhereInput = {}
    if (q.status) where.status = q.status
    if (q.flagged === 'true') where.eligibilityResult = 'NEEDS_REVIEW'
    if (q.flagged === 'false') where.eligibilityResult = 'PASSED'
    if (q.flag) where.flags = { has: q.flag }
    if (q.assigned === 'me' && admin) where.assignedAdminId = admin.id
    if (q.assigned === 'none') where.assignedAdminId = null
    if (q.from || q.to) {
      where.createdAt = { ...(q.from ? { gte: new Date(q.from) } : {}), ...(q.to ? { lte: new Date(q.to) } : {}) }
    }
    const term = q.q?.trim()
    if (term) {
      const contains = { contains: term, mode: 'insensitive' as const }
      where.OR = [
        { reference: contains },
        { senderName: contains },
        { senderEmail: contains },
        { senderPhone: contains },
        { recipientName: contains },
        { recipientPhone: contains },
        { recipientEmail: contains },
      ]
    }
    return where
  }

  async list(q: ListGiftSubmissionsDto, admin: AuthenticatedAdmin) {
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 25
    const where = this.where(q, admin)
    const [items, total] = await Promise.all([
      this.prisma.giftCampaignSubmission.findMany({
        where,
        include: LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.giftCampaignSubmission.count({ where }),
    ])
    return { items, total, page, pageSize }
  }

  async exportCsv(q: ListGiftSubmissionsDto, admin: AuthenticatedAdmin): Promise<string> {
    const rows = capRows(
      await this.prisma.giftCampaignSubmission.findMany({
        where: this.where(q, admin),
        include: LIST_INCLUDE,
        orderBy: { createdAt: 'desc' },
        take: EXPORT_TAKE,
      }),
    )
    await auditExport(this.prisma, admin, 'export_gift_submissions', rows.length, {
      status: q.status,
      flagged: q.flagged,
      from: q.from,
      to: q.to,
    })
    return toCsv(EXPORT_COLUMNS, rows)
  }

  async get(id: string) {
    const row = await this.prisma.giftCampaignSubmission.findUnique({
      where: { id },
      include: {
        assignedAdmin: { select: { id: true, name: true, email: true } },
        entitlement: {
          select: {
            id: true,
            status: true,
            expiresAt: true,
            linkDeliveryChannel: true,
            linkDeliveredAt: true,
            linkDeliveryError: true,
            firstOpenedAt: true,
            createdAt: true,
            order: {
              select: {
                id: true,
                paymentIntentId: true,
                productType: true,
                countryCode: true,
                chargeAmount: true,
                chargeCurrency: true,
                status: true,
                refunded: true,
                disputed: true,
                createdAt: true,
              },
            },
          },
        },
        // Voucher order summary only — the code/PIN stay behind the restricted order view.
        voucherOrder: {
          select: {
            id: true,
            paymentIntentId: true,
            productName: true,
            providerAmount: true,
            providerCurrency: true,
            status: true,
            fulfillment: { select: { status: true, providerTransactionId: true, lastError: true, fulfilledAt: true } },
          },
        },
        events: {
          orderBy: { createdAt: 'asc' },
          include: { admin: { select: { id: true, name: true } } },
        },
      },
    })
    if (!row) throw new NotFoundException('Submission not found')
    return { ...row, allowedTransitions: TRANSITIONS[row.status] }
  }

  async transition(id: string, dto: TransitionGiftDto, admin: AuthenticatedAdmin) {
    const current = await this.prisma.giftCampaignSubmission.findUnique({
      where: { id },
      include: { customer: { select: { firstName: true } } },
    })
    if (!current) throw new NotFoundException('Submission not found')
    try {
      assertTransition(current.status, dto.status, dto.reasonCode, dto.note)
    } catch (err) {
      if (err instanceof GiftTransitionError) throw new BadRequestException(err.message)
      throw err
    }
    if (dto.status === 'AWAITING_REDEMPTION' && !current.voucherOrderId && !dto.note?.trim()) {
      throw new BadRequestException('Without an issued voucher, record how the gift is being fulfilled in the note')
    }

    const now = new Date()
    const data: Prisma.GiftCampaignSubmissionUpdateManyMutationInput = { status: dto.status }
    if (REASONS_BY_STATUS[dto.status]) {
      data.reasonCode = dto.reasonCode ?? null
      data.reasonNote = dto.note?.trim() || null
    }
    if (dto.status === 'APPROVED') data.approvedAt = now
    if (dto.status === 'FULFILLED') data.fulfilledAt = now
    if (dto.status === 'SENDER_NOTIFIED') data.senderNotifiedAt = now

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      // Guarded on the status we validated against: a concurrent change makes this a no-op.
      const moved = await tx.giftCampaignSubmission.updateMany({ where: { id, status: current.status }, data })
      if (moved.count !== 1) throw new ConflictException('This submission was changed by someone else; reload and try again')
      await tx.giftCampaignEvent.create({
        data: {
          submissionId: id,
          type: 'STATUS_CHANGED',
          fromStatus: current.status,
          toStatus: dto.status,
          reasonCode: dto.reasonCode ?? null,
          note: dto.note?.trim() || null,
          actorType: 'ADMIN',
          adminId: admin.id,
        },
      })
      // A cancelled case gives the link back nothing — the entitlement stays used.
    })
    await this.audit(admin, `gift_status_${dto.status.toLowerCase()}`, current.reference, dto.reasonCode ?? 'ok')

    const kind = NOTIFY_ON[dto.status]
    let notified: boolean | null = null
    if (kind) {
      notified = await this.notifySender(current, kind, dto.reasonCode ?? null)
      if (kind === 'fulfilled' && notified) {
        // Completion message went out: close the case as the brief describes.
        const closed = await this.prisma.giftCampaignSubmission.updateMany({
          where: { id, status: 'FULFILLED' },
          data: { status: 'SENDER_NOTIFIED', senderNotifiedAt: new Date() },
        })
        if (closed.count === 1) {
          await this.prisma.giftCampaignEvent.create({
            data: { submissionId: id, type: 'STATUS_CHANGED', fromStatus: 'FULFILLED', toStatus: 'SENDER_NOTIFIED', actorType: 'SYSTEM' },
          })
        }
      }
    }
    return { ...(await this.get(id)), notified }
  }

  /** Logs a recipient contact attempt. A successful one moves an APPROVED case to RECIPIENT_CONTACTED. */
  async contactAttempt(id: string, dto: ContactAttemptDto, admin: AuthenticatedAdmin) {
    const current = await this.prisma.giftCampaignSubmission.findUnique({ where: { id }, select: { status: true, reference: true } })
    if (!current) throw new NotFoundException('Submission not found')
    await this.prisma.giftCampaignEvent.create({
      data: {
        submissionId: id,
        type: 'CONTACT_ATTEMPT',
        channel: dto.channel,
        outcome: dto.outcome,
        note: dto.note?.trim() || null,
        actorType: 'ADMIN',
        adminId: admin.id,
      },
    })
    if (dto.outcome === 'reached' && current.status === 'APPROVED') {
      const moved = await this.prisma.giftCampaignSubmission.updateMany({
        where: { id, status: 'APPROVED' },
        data: { status: 'RECIPIENT_CONTACTED' },
      })
      if (moved.count === 1) {
        await this.prisma.giftCampaignEvent.create({
          data: {
            submissionId: id,
            type: 'STATUS_CHANGED',
            fromStatus: 'APPROVED',
            toStatus: 'RECIPIENT_CONTACTED',
            actorType: 'ADMIN',
            adminId: admin.id,
          },
        })
      }
    }
    await this.audit(admin, 'gift_contact_attempt', current.reference, `${dto.channel}:${dto.outcome}`)
    return this.get(id)
  }

  async addNote(id: string, dto: GiftNoteDto, admin: AuthenticatedAdmin) {
    await this.mustExist(id)
    await this.prisma.giftCampaignEvent.create({
      data: { submissionId: id, type: 'NOTE', note: dto.note.trim(), actorType: 'ADMIN', adminId: admin.id },
    })
    return this.get(id)
  }

  async assign(id: string, dto: AssignGiftDto, admin: AuthenticatedAdmin) {
    const current = await this.mustExist(id)
    const assigneeId = dto.adminId === 'me' ? admin.id : dto.adminId
    if (assigneeId) {
      const exists = await this.prisma.adminUser.findUnique({ where: { id: assigneeId }, select: { active: true } })
      if (!exists?.active) throw new BadRequestException('No active admin with that id')
    }
    await this.prisma.giftCampaignSubmission.update({ where: { id }, data: { assignedAdminId: assigneeId } })
    await this.prisma.giftCampaignEvent.create({
      data: { submissionId: id, type: 'ASSIGNED', note: assigneeId ?? 'unassigned', actorType: 'ADMIN', adminId: admin.id },
    })
    await this.audit(admin, 'gift_assign', current.reference, assigneeId ?? 'unassigned')
    return this.get(id)
  }

  /** Links issued (for "I never got my link" support). Token hashes are never returned. */
  async listEntitlements(q: ListGiftEntitlementsDto) {
    const page = q.page ?? 1
    const pageSize = q.pageSize ?? 25
    const where: Prisma.GiftCampaignEntitlementWhereInput = {}
    if (q.status) where.status = q.status
    const term = q.q?.trim()
    if (term) {
      where.customer = {
        OR: [
          { email: { contains: term, mode: 'insensitive' } },
          { phone: { contains: term } },
        ],
      }
    }
    const [items, total] = await Promise.all([
      this.prisma.giftCampaignEntitlement.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        select: {
          id: true,
          campaignKey: true,
          status: true,
          expiresAt: true,
          linkDeliveryChannel: true,
          linkDeliveredAt: true,
          linkDeliveryError: true,
          firstOpenedAt: true,
          createdAt: true,
          orderId: true,
          customer: { select: { id: true, email: true, phone: true, firstName: true, lastName: true } },
          submission: { select: { id: true, reference: true, status: true } },
        },
      }),
      this.prisma.giftCampaignEntitlement.count({ where }),
    ])
    return { items, total, page, pageSize }
  }

  /** Re-sends the same link to the account email (the link is re-derived, not re-minted). */
  async resendLink(entitlementId: string, admin: AuthenticatedAdmin) {
    const row = await this.prisma.giftCampaignEntitlement.findUnique({
      where: { id: entitlementId },
      include: { customer: { select: { email: true, firstName: true } } },
    })
    if (!row) throw new NotFoundException('Link not found')
    if (row.status !== 'LINK_ISSUED' || row.expiresAt <= new Date()) {
      throw new ConflictException(`This link is ${row.status === 'LINK_ISSUED' ? 'expired' : row.status.toLowerCase()}; nothing to resend`)
    }
    const sent = await this.entitlements.deliverLink(row, row.customer, undefined, { adminId: admin.id })
    await this.audit(admin, 'gift_resend_link', row.id, sent ? 'success' : 'failed')
    return { sent }
  }

  private async mustExist(id: string) {
    const row = await this.prisma.giftCampaignSubmission.findUnique({ where: { id }, select: { id: true, reference: true } })
    if (!row) throw new NotFoundException('Submission not found')
    return row
  }

  private async notifySender(
    s: { id: string; senderEmail: string; reference: string; customer: { firstName: string } },
    kind: NotifyKind,
    reasonCode: string | null,
  ): Promise<boolean> {
    const rewardGbp = this.entitlements.config().rewardGbp
    const base = { to: s.senderEmail, firstName: s.customer.firstName, reference: s.reference }
    const sent =
      kind === 'rejected'
        ? await this.email.sendGiftCampaignEmail({ kind, ...base, reason: customerRejectionReason(reasonCode) })
        : await this.email.sendGiftCampaignEmail({ kind, ...base, rewardGbp })
    try {
      await this.prisma.giftCampaignEvent.create({
        data: { submissionId: s.id, type: sent ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED', channel: 'email', note: kind, actorType: 'SYSTEM' },
      })
    } catch (err) {
      this.logger.warn(`Could not record ${kind} notification for ${s.id}: ${(err as Error).message}`)
    }
    return sent
  }

  private async audit(admin: AuthenticatedAdmin, action: string, target: string, result: string) {
    try {
      await this.prisma.adminAuditLog.create({ data: { adminId: admin.id, action, target, result: result.slice(0, 500) } })
    } catch {
      // best-effort, as elsewhere in the console
    }
  }
}
