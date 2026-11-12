// Public landing-page flow (token-authenticated) and the signed-in customer's view.
import {
  BadRequestException,
  ConflictException,
  GoneException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common'
import { Prisma, type GiftCampaignEntitlement } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CustomerEmailService } from '../common/customer-email.service'
import { GiftEntitlementService } from './gift-entitlement.service'
import { hashLinkToken, isWellFormedToken, newSubmissionReference, tokenMatches } from './gift-token'
import { computeFlags, validateSubmission, type SubmissionInput } from './gift-submission'
import { customerStatusLabel } from './gift-status'

export type LinkState = 'open' | 'submitted' | 'expired' | 'closed'

export const SUBMISSION_RECEIVED_MESSAGE =
  "Thanks. Your details have been received and are being checked. We'll update you once your gift is approved."

@Injectable()
export class GiftCampaignService {
  private readonly logger = new Logger(GiftCampaignService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly entitlements: GiftEntitlementService,
    private readonly email: CustomerEmailService,
  ) {}

  /** The entitlement a presented token belongs to, or null. Constant-time compare after the indexed lookup. */
  async resolveToken(token: string) {
    if (!isWellFormedToken(token)) return null
    const row = await this.prisma.giftCampaignEntitlement.findUnique({
      where: { tokenHash: hashLinkToken(token) },
      include: {
        customer: { select: { firstName: true, lastName: true, email: true, phone: true } },
        submission: { select: { reference: true, createdAt: true } },
      },
    })
    if (!row || !tokenMatches(this.entitlements.secret(), token, row)) return null
    return row
  }

  stateOf(row: Pick<GiftCampaignEntitlement, 'status' | 'expiresAt' | 'campaignKey'>, now = new Date()): LinkState {
    const config = this.entitlements.config()
    if (row.status === 'SUBMITTED') return 'submitted'
    if (!config.enabled || row.status === 'CANCELLED' || row.campaignKey !== config.campaignKey) return 'closed'
    if (row.status === 'EXPIRED' || row.expiresAt <= now) return 'expired'
    return 'open'
  }

  /** GET /gift-campaign/links/:token — only what the page needs. */
  async viewLink(token: string) {
    const row = await this.resolveToken(token)
    if (!row) throw new NotFoundException('This gift link is not valid')
    const config = this.entitlements.config()
    const state = this.stateOf(row)

    if (state === 'expired' && row.status === 'LINK_ISSUED') {
      await this.markExpired(row.id)
    }
    if (state === 'open' && !row.firstOpenedAt) {
      // Best effort: funnel metric only.
      try {
        const opened = await this.prisma.giftCampaignEntitlement.updateMany({
          where: { id: row.id, firstOpenedAt: null },
          data: { firstOpenedAt: new Date() },
        })
        if (opened.count === 1) {
          await this.prisma.giftCampaignEvent.create({
            data: { entitlementId: row.id, type: 'LINK_OPENED', actorType: 'CUSTOMER' },
          })
        }
      } catch (err) {
        this.logger.warn(`Could not record link open for ${row.id}: ${(err as Error).message}`)
      }
    }

    return {
      state,
      expiresAt: row.expiresAt.toISOString(),
      campaignEndsAt: config.endsAt?.toISOString() ?? null,
      rewardGbp: config.rewardGbp,
      termsVersion: config.termsVersion,
      termsUrl: config.termsUrl,
      privacyUrl: config.privacyUrl,
      supportEmail: config.supportEmail,
      ...(state === 'open'
        ? {
            sender: {
              fullName: `${row.customer.firstName} ${row.customer.lastName}`.trim(),
              email: row.customer.email,
              phone: row.customer.phone,
            },
          }
        : {}),
      ...(state === 'submitted' && row.submission
        ? { submission: { reference: row.submission.reference, submittedAt: row.submission.createdAt.toISOString() } }
        : {}),
    }
  }

  /** POST /gift-campaign/links/:token/submission */
  async submit(token: string, input: SubmissionInput) {
    const row = await this.resolveToken(token)
    if (!row) throw new NotFoundException('This gift link is not valid')
    const config = this.entitlements.config()

    const state = this.stateOf(row)
    if (state === 'submitted') throw new ConflictException('Gift details have already been submitted with this link')
    if (state === 'expired') {
      if (row.status === 'LINK_ISSUED') await this.markExpired(row.id)
      throw new GoneException('This gift link has expired')
    }
    if (state === 'closed') throw new GoneException('This campaign is no longer available')

    const checked = validateSubmission(input)
    if (!checked.ok) throw new BadRequestException(checked.errors)
    const s = checked.value
    if (s.termsVersion !== config.termsVersion) {
      throw new ConflictException('The campaign terms have been updated. Please reload the page and review them.')
    }

    const order = await this.prisma.order.findUnique({
      where: { id: row.orderId },
      select: { status: true, refunded: true, disputed: true },
    })
    const sameCampaign = { campaignKey: config.campaignKey, entitlementId: { not: row.id } }
    const [samePhone, sameEmail, sameCustomer] = await Promise.all([
      this.prisma.giftCampaignSubmission.count({ where: { ...sameCampaign, recipientPhone: s.recipientPhone } }),
      s.recipientEmail
        ? this.prisma.giftCampaignSubmission.count({ where: { ...sameCampaign, recipientEmail: s.recipientEmail } })
        : Promise.resolve(0),
      this.prisma.giftCampaignSubmission.count({ where: { ...sameCampaign, customerId: row.customerId } }),
    ])
    const flags = computeFlags({
      submission: s,
      account: { email: row.customer.email, phone: row.customer.phone },
      order: order ?? { status: 'MISSING', refunded: false, disputed: false },
      otherSubmissionsSameRecipientPhone: samePhone,
      otherSubmissionsSameRecipientEmail: sameEmail,
      otherSubmissionsSameCustomer: sameCustomer,
    })

    const now = new Date()
    let created: { id: string; reference: string }
    try {
      created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Single use, enforced in the DB: only the caller that flips LINK_ISSUED -> SUBMITTED
        // (and only before expiry) may create the submission. entitlementId is also UNIQUE.
        const claimed = await tx.giftCampaignEntitlement.updateMany({
          where: { id: row.id, status: 'LINK_ISSUED', expiresAt: { gt: now } },
          data: { status: 'SUBMITTED' },
        })
        if (claimed.count !== 1) throw new ConflictException('Gift details have already been submitted with this link')

        const submission = await tx.giftCampaignSubmission.create({
          data: {
            reference: newSubmissionReference(),
            campaignKey: row.campaignKey,
            entitlementId: row.id,
            customerId: row.customerId,
            senderName: s.senderName,
            senderEmail: s.senderEmail,
            senderPhone: s.senderPhone,
            recipientName: s.recipientName,
            recipientPhone: s.recipientPhone,
            recipientEmail: s.recipientEmail,
            relationship: s.relationship,
            preferredContact: s.preferredContact,
            declarationAcceptedAt: now,
            termsVersion: config.termsVersion,
            termsAcceptedAt: now,
            status: 'SUBMITTED',
            flags,
            eligibilityResult: flags.length ? 'NEEDS_REVIEW' : 'PASSED',
          },
        })
        await tx.giftCampaignEvent.create({
          data: { entitlementId: row.id, submissionId: submission.id, type: 'SUBMITTED', toStatus: 'SUBMITTED', actorType: 'CUSTOMER' },
        })
        // Automated checks have run (flags above), so the case now waits for a reviewer.
        await tx.giftCampaignSubmission.update({ where: { id: submission.id }, data: { status: 'PENDING_VALIDATION' } })
        await tx.giftCampaignEvent.create({
          data: {
            submissionId: submission.id,
            type: 'STATUS_CHANGED',
            fromStatus: 'SUBMITTED',
            toStatus: 'PENDING_VALIDATION',
            note: flags.length ? `Automated checks flagged: ${flags.join(', ')}` : 'Automated checks passed',
            actorType: 'SYSTEM',
          },
        })
        return { id: submission.id, reference: submission.reference }
      })
    } catch (err) {
      if (err instanceof ConflictException) throw err
      if ((err as { code?: string })?.code === 'P2002') {
        throw new ConflictException('Gift details have already been submitted with this link')
      }
      throw err
    }

    const sent = await this.email.sendGiftCampaignEmail({
      kind: 'submission_received',
      to: s.senderEmail,
      firstName: row.customer.firstName,
      reference: created.reference,
      rewardGbp: config.rewardGbp,
    })
    await this.recordNotification(created.id, 'submission_received', sent)

    return { reference: created.reference, status: 'received' as const, message: SUBMISSION_RECEIVED_MESSAGE }
  }

  /** GET /customer/gift-campaign — the signed-in customer's links, so the app can show them in-app. */
  async listForCustomer(customerId: string) {
    const config = this.entitlements.config()
    const rows = await this.prisma.giftCampaignEntitlement.findMany({
      where: { customerId },
      orderBy: { createdAt: 'desc' },
      include: { submission: { select: { reference: true, status: true, createdAt: true } } },
    })
    return {
      enabled: config.enabled,
      rewardGbp: config.rewardGbp,
      entitlements: rows.map((row) => {
        const state = this.stateOf(row)
        return {
          id: row.id,
          state,
          // Re-derived from the secret; only ever shown to the signed-in owner.
          link: state === 'open' ? this.entitlements.linkFor(row) : null,
          expiresAt: row.expiresAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
          submission: row.submission
            ? {
                reference: row.submission.reference,
                submittedAt: row.submission.createdAt.toISOString(),
                status: customerStatusLabel(row.submission.status),
              }
            : null,
        }
      }),
    }
  }

  private async markExpired(id: string) {
    try {
      const res = await this.prisma.giftCampaignEntitlement.updateMany({
        where: { id, status: 'LINK_ISSUED' },
        data: { status: 'EXPIRED' },
      })
      if (res.count === 1) {
        await this.prisma.giftCampaignEvent.create({
          data: { entitlementId: id, type: 'STATUS_CHANGED', fromStatus: 'LINK_ISSUED', toStatus: 'EXPIRED', actorType: 'SYSTEM' },
        })
      }
    } catch (err) {
      this.logger.warn(`Could not mark entitlement ${id} expired: ${(err as Error).message}`)
    }
  }

  private async recordNotification(submissionId: string, kind: string, sent: boolean) {
    try {
      await this.prisma.giftCampaignEvent.create({
        data: { submissionId, type: sent ? 'NOTIFICATION_SENT' : 'NOTIFICATION_FAILED', channel: 'email', note: kind, actorType: 'SYSTEM' },
      })
    } catch (err) {
      this.logger.warn(`Could not record ${kind} notification for ${submissionId}: ${(err as Error).message}`)
    }
  }
}
