// Issues campaign links after a qualifying order is fulfilled, and delivers them.
//
// Called fire-and-forget from FulfillmentService's success phase. Nothing here may ever
// affect fulfilment: `onOrderFulfilled` never throws, and the caller also guards it.
import { Injectable, Logger } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CustomerEmailService } from '../common/customer-email.service'
import { linkExpiry, readGiftCampaignConfig, type GiftCampaignConfig } from './gift-campaign.config'
import { evaluateOrderEligibility, underCustomerLimit, type IneligibleReason } from './gift-eligibility'
import { deriveLinkToken, hashLinkToken, linkTokenSecret, newTokenSalt } from './gift-token'

export type IssueOutcome =
  | { issued: true; entitlementId: string }
  | { issued: false; reason: IneligibleReason | 'ALREADY_ISSUED' | 'CUSTOMER_LIMIT' | 'NO_SECRET' | 'ORDER_NOT_FOUND' | 'ERROR' }

const DEFAULT_SITE_URL = 'https://mobiletopup.planettalk.com'

@Injectable()
export class GiftEntitlementService {
  private readonly logger = new Logger(GiftEntitlementService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: CustomerEmailService,
  ) {}

  /** Re-read per call so tests and ops changes to env take effect without a restart of this service. */
  config(): GiftCampaignConfig {
    return readGiftCampaignConfig()
  }

  secret(): string {
    return linkTokenSecret()
  }

  /** The landing-page URL for an entitlement. Contains only the opaque token. */
  linkFor(row: { id: string; tokenSalt: string }, locale?: string): string {
    const site = (process.env.PUBLIC_SITE_URL || DEFAULT_SITE_URL).replace(/\/+$/, '')
    const token = deriveLinkToken(this.secret(), row.id, row.tokenSalt)
    return `${site}/${encodeURIComponent(locale || this.config().linkLocale)}/gift/${token}`
  }

  /** Never throws. */
  async onOrderFulfilled(orderId: string): Promise<IssueOutcome> {
    try {
      return await this.issueForOrder(orderId)
    } catch (err) {
      this.logger.error(`Gift campaign link issuance failed for order ${orderId}`, err as Error)
      return { issued: false, reason: 'ERROR' }
    }
  }

  async issueForOrder(orderId: string, now = new Date()): Promise<IssueOutcome> {
    const config = this.config()
    if (!config.enabled) return { issued: false, reason: 'CAMPAIGN_DISABLED' }
    const secret = this.secret()
    if (!secret) {
      this.logger.error('Gift campaign is enabled but no GIFT_CAMPAIGN_TOKEN_SECRET/JWT_SECRET is set; no link issued')
      return { issued: false, reason: 'NO_SECRET' }
    }

    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: { customer: { select: { id: true, email: true, firstName: true, phone: true } } },
    })
    if (!order) return { issued: false, reason: 'ORDER_NOT_FOUND' }

    const verdict = evaluateOrderEligibility(order, order.customer?.phone ?? null, config)
    if (!verdict.eligible) return { issued: false, reason: verdict.reason }
    const customer = order.customer!

    const salt = newTokenSalt()
    let created: { id: string; tokenSalt: string; expiresAt: Date } | null = null
    try {
      created = await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        // Serialise issuance per customer so two orders fulfilled at once cannot both
        // slip under the per-customer limit.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'gift:' + customer.id}))`
        const existing = await tx.giftCampaignEntitlement.count({
          where: { customerId: customer.id, campaignKey: config.campaignKey, status: { not: 'CANCELLED' } },
        })
        if (!underCustomerLimit(existing, config)) return null

        // The id is needed to derive the token, so create with a placeholder hash, then set it.
        const row = await tx.giftCampaignEntitlement.create({
          data: {
            campaignKey: config.campaignKey,
            customerId: customer.id,
            orderId: order.id,
            tokenHash: `pending:${salt}`,
            tokenSalt: salt,
            expiresAt: linkExpiry(config, now),
          },
        })
        const tokenHash = hashLinkToken(deriveLinkToken(secret, row.id, salt))
        await tx.giftCampaignEntitlement.update({ where: { id: row.id }, data: { tokenHash } })
        await tx.giftCampaignEvent.create({
          data: { entitlementId: row.id, type: 'LINK_ISSUED', toStatus: 'LINK_ISSUED', actorType: 'SYSTEM' },
        })
        return { id: row.id, tokenSalt: salt, expiresAt: row.expiresAt }
      })
    } catch (err) {
      // orderId is UNIQUE: a replayed fulfilment lands here and is a no-op.
      if ((err as { code?: string })?.code === 'P2002') return { issued: false, reason: 'ALREADY_ISSUED' }
      throw err
    }
    if (!created) return { issued: false, reason: 'CUSTOMER_LIMIT' }

    await this.deliverLink(created, customer, config)
    return { issued: true, entitlementId: created.id }
  }

  /** Emails the link and records the delivery result. Used on issue and for support resends. */
  async deliverLink(
    entitlement: { id: string; tokenSalt: string; expiresAt: Date },
    customer: { email: string; firstName: string },
    config: GiftCampaignConfig = this.config(),
    actor: { adminId?: string } = {},
  ): Promise<boolean> {
    const sent = await this.email.sendGiftCampaignEmail({
      kind: 'link_issued',
      to: customer.email,
      firstName: customer.firstName,
      link: this.linkFor(entitlement),
      expiresAt: entitlement.expiresAt,
      rewardGbp: config.rewardGbp,
    })
    try {
      await this.prisma.giftCampaignEntitlement.update({
        where: { id: entitlement.id },
        data: sent
          ? { linkDeliveryChannel: 'email', linkDeliveredAt: new Date(), linkDeliveryError: null }
          : { linkDeliveryChannel: 'email', linkDeliveryError: 'Email not sent (see logs)' },
      })
      await this.prisma.giftCampaignEvent.create({
        data: {
          entitlementId: entitlement.id,
          type: sent ? 'LINK_DELIVERED' : 'LINK_DELIVERY_FAILED',
          channel: 'email',
          actorType: actor.adminId ? 'ADMIN' : 'SYSTEM',
          adminId: actor.adminId ?? null,
        },
      })
    } catch (err) {
      this.logger.error(`Could not record link delivery for entitlement ${entitlement.id}`, err as Error)
    }
    return sent
  }
}
