import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { CustomersModule } from '../customers/customers.module'
import { PaymentsModule } from '../payments/payments.module'
import { BuhibabModule } from '../providers/buhibab/buhibab.module'
import { GiftCampaignCoreModule } from './gift-campaign-core.module'
import { CustomerGiftCampaignController, GiftCampaignController } from './gift-campaign.controller'
import { AdminGiftCampaignController } from './admin-gift-campaign.controller'
import { GiftCampaignService } from './gift-campaign.service'
import { GiftCampaignAdminService } from './gift-campaign-admin.service'
import { GiftVoucherIssuerService } from './gift-voucher-issuer.service'

/** "Gift a Loved One in Nigeria": landing page API, customer view, operations console API. */
@Module({
  imports: [GiftCampaignCoreModule, AuthModule, CustomersModule, PaymentsModule, BuhibabModule],
  controllers: [GiftCampaignController, CustomerGiftCampaignController, AdminGiftCampaignController],
  providers: [GiftCampaignService, GiftCampaignAdminService, GiftVoucherIssuerService],
})
export class GiftCampaignModule {}
