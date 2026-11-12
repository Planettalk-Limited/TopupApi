import { Module } from '@nestjs/common'
import { GiftEntitlementService } from './gift-entitlement.service'

/**
 * The part of the gift campaign that PaymentsModule needs (link issuance on fulfilment).
 * Kept apart from GiftCampaignModule, which itself imports PaymentsModule for the voucher
 * executor, so there is no circular import. Prisma and email come from the global CommonModule.
 */
@Module({
  providers: [GiftEntitlementService],
  exports: [GiftEntitlementService],
})
export class GiftCampaignCoreModule {}
