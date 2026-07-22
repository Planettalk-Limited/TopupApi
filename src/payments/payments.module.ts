import { Module } from '@nestjs/common'
import { CommonModule } from '../common/common.module'
import { ReloadlyModule } from '../providers/reloadly/reloadly.module'
import { ReloadlyTopupExecutor } from './executors/reloadly-topup.executor'
import { FulfillmentService } from './fulfillment.service'
import { PaymentsController } from './payments.controller'
import { PricingService } from './pricing.service'
import { SignatureService } from './signature.service'
import { StripeService } from './stripe.service'

@Module({
  // ReloadlyModule exports ReloadlyService (needed by PricingService/ReloadlyTopupExecutor);
  // CommonModule exports PrismaService (needed by PaymentsController/FulfillmentService).
  imports: [ReloadlyModule, CommonModule],
  controllers: [PaymentsController],
  providers: [StripeService, PricingService, SignatureService, ReloadlyTopupExecutor, FulfillmentService],
})
export class PaymentsModule {}
