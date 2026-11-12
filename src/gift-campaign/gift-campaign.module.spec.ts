import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { FulfillmentService } from '../payments/fulfillment.service'
import { GiftCampaignModule } from './gift-campaign.module'
import { GiftCampaignService } from './gift-campaign.service'
import { GiftCampaignAdminService } from './gift-campaign-admin.service'
import { GiftVoucherIssuerService } from './gift-voucher-issuer.service'
import { GiftEntitlementService } from './gift-entitlement.service'

// DI-wiring smoke test, as for AdminModule/PaymentsModule: catches a missing export or a
// circular import between GiftCampaignModule and PaymentsModule (which uses the core module).
describe('GiftCampaignModule', () => {
  it('compiles, resolves its services, and wires the link issuer into fulfilment', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), GiftCampaignModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    expect(moduleRef.get(GiftCampaignService)).toBeDefined()
    expect(moduleRef.get(GiftCampaignAdminService)).toBeDefined()
    expect(moduleRef.get(GiftVoucherIssuerService)).toBeDefined()
    const fulfillment = moduleRef.get(FulfillmentService) as unknown as { giftEntitlements?: unknown }
    expect(fulfillment.giftEntitlements).toBeInstanceOf(GiftEntitlementService)
  })
})
