import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { Type } from 'class-transformer'
import { IsNotEmpty, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import { CurrentCustomer } from '../customers/current-customer.decorator'
import { CustomerAuthGuard } from '../customers/customer-auth.guard'
import { AuthenticatedCustomer } from '../customers/customer-jwt'
import { normalizePromoCode, PromoError, PromoService } from '../promo/promo.service'
import { HealthcareService } from '../providers/buhibab/healthcare.service'
import { prepareAndPriceOrder } from './checkout-order'
import { FulfillmentOrderDto } from './dto/create-intent.dto'
import { PricingService } from './pricing.service'

export class ValidatePromoDto {
  @IsString() @IsNotEmpty() @MaxLength(40) code!: string
  @IsOptional() @IsString() @MaxLength(10) currency?: string

  @ValidateNested()
  @Type(() => FulfillmentOrderDto)
  order!: FulfillmentOrderDto
}

/**
 * POST /api/promo/validate — lets the payment step show the discounted total before Pay.
 * Advisory only: create-intent re-runs the same pricing + promo checks and is what
 * actually decides the charge. Lives in PaymentsModule because it must price the order
 * through the very same path (checkout-order.ts) as create-intent.
 */
@Controller('promo')
@UseGuards(CustomerAuthGuard)
export class PromoController {
  constructor(
    private readonly pricing: PricingService,
    private readonly healthcare: HealthcareService,
    private readonly promo: PromoService,
  ) {}

  // Each call prices against the provider; also caps code guessing.
  @Throttle({ default: { limit: 20, ttl: 60_000 } })
  @HttpCode(200)
  @Post('validate')
  async validate(@CurrentCustomer() customer: AuthenticatedCustomer, @Body() dto: ValidatePromoDto) {
    const { order, currency, subtotal } = await prepareAndPriceOrder(
      { pricing: this.pricing, healthcare: this.healthcare },
      dto.order,
      dto.currency,
    )
    const base = { code: normalizePromoCode(dto.code), subtotal, currency: currency.toUpperCase() }

    try {
      const quote = await this.promo.quote({
        code: dto.code,
        customerId: customer.id,
        productType: order.productType,
        subtotal,
        currency,
      })
      return { valid: true, ...base, discount: quote.discount, total: quote.total }
    } catch (error) {
      if (error instanceof PromoError) {
        return { valid: false, ...base, discount: 0, total: subtotal, message: error.message, reason: error.code }
      }
      throw error
    }
  }
}
