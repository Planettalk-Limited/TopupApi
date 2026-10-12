import { Module } from '@nestjs/common'
import { PromoService } from './promo.service'

/**
 * Promo-code rules. Kept free of PaymentsModule so PaymentsModule can import it; the
 * customer-facing /api/promo/validate endpoint lives in PaymentsModule because it has to
 * price the order exactly as create-intent does.
 */
@Module({
  providers: [PromoService],
  exports: [PromoService],
})
export class PromoModule {}
