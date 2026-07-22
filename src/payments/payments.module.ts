import { Module } from '@nestjs/common'
import { CommonModule } from '../common/common.module'
import { ReloadlyModule } from '../providers/reloadly/reloadly.module'
import { BuhibabModule } from '../providers/buhibab/buhibab.module'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { ReloadlyGiftCardExecutor } from './executors/reloadly-gift-card.executor'
import { ReloadlyPayBillExecutor } from './executors/reloadly-pay-bill.executor'
import { PlanetTalkTopupExecutor } from './executors/planettalk-topup.executor'
import { PlanetTalkPayBillExecutor } from './executors/planettalk-pay-bill.executor'
import { FulfillmentService } from './fulfillment.service'
import { PaymentsController } from './payments.controller'
import { PricingService } from './pricing.service'
import { ReconciliationService } from './reconciliation.service'
import { SignatureService } from './signature.service'
import { StripeService } from './stripe.service'

@Module({
  // ReloadlyModule exports ReloadlyService (needed by PricingService/Reloadly executors);
  // BuhibabModule exports PlanetTalkService (needed by PricingService/PlanetTalk executors);
  // CommonModule exports PrismaService (needed by PaymentsController/FulfillmentService).
  imports: [ReloadlyModule, BuhibabModule, CommonModule],
  controllers: [PaymentsController],
  providers: [
    StripeService,
    PricingService,
    SignatureService,
    ReloadlyTopupExecutor,
    ReloadlyGiftCardExecutor,
    ReloadlyPayBillExecutor,
    PlanetTalkTopupExecutor,
    PlanetTalkPayBillExecutor,
    FulfillmentService,
    ReconciliationService,
  ],
  // FulfillmentService is re-used by AdminModule's retry() (SP-2 Phase 4) to
  // re-run fulfilment for a stuck order via the same claim/execute/record engine.
  exports: [FulfillmentService],
})
export class PaymentsModule {}
