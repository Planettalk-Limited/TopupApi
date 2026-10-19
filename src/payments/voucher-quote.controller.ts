import { Body, Controller, HttpException, Post, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator'
import { VouchersEnabledGuard } from '../common/vouchers-enabled'
import { resolveChargeCurrency } from './charge-currency'
import { PricingError, PricingService } from './pricing.service'
import { validateStripeAmount } from './static-fx'

export class VoucherQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string

  @IsInt()
  @Min(1)
  productId!: number

  /** Face value in whole NGN. */
  @IsInt()
  @Min(1)
  @Max(10_000_000)
  amount!: number
}

/**
 * Prices a voucher before checkout with exactly the code create-intent uses, so the total
 * the customer sees is the total they are charged.
 */
@Controller('payments/vouchers')
@UseGuards(VouchersEnabledGuard)
export class VoucherQuoteController {
  constructor(private readonly pricing: PricingService) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('quote')
  async quote(@Body() dto: VoucherQuoteDto) {
    const currency = resolveChargeCurrency(dto.currency)

    let amount: number
    try {
      amount = await this.pricing.chargeForVoucher(dto.productId, dto.amount, currency)
    } catch (error) {
      if (error instanceof PricingError) throw new HttpException(error.message, error.statusCode)
      throw error
    }

    const stripe = validateStripeAmount(amount, currency)
    return {
      productId: dto.productId,
      providerAmount: dto.amount,
      providerCurrency: 'NGN',
      amount,
      currency: currency.toUpperCase(),
      // False when the voucher is below the card network minimum for this currency — the
      // UI should ask for a larger amount rather than let create-intent reject it.
      payable: stripe.valid,
      ...(stripe.valid ? {} : { message: stripe.error }),
    }
  }
}
