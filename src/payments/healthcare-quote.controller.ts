import {
  Body,
  Controller,
  HttpException,
  NotFoundException,
  Post,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { HealthcareEnabledGuard } from '../common/healthcare-enabled'
import { Type } from 'class-transformer'
import { ArrayMaxSize, ArrayMinSize, IsArray, IsOptional, IsString, MaxLength, ValidateNested } from 'class-validator'
import { HealthcareService } from '../providers/buhibab/healthcare.service'
import { HealthcareDrugLineDto } from './dto/create-intent.dto'
import { HEALTHCARE_MAX_LINES } from './healthcare-order'
import { HEALTHCARE_MIN_NGN, PricingError, PricingService, healthcareBasketShortfall } from './pricing.service'
import { validateStripeAmount } from './static-fx'

export class HealthcareQuoteDto {
  @IsOptional()
  @IsString()
  @MaxLength(10)
  currency?: string

  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(HEALTHCARE_MAX_LINES)
  @ValidateNested({ each: true })
  @Type(() => HealthcareDrugLineDto)
  drugs!: HealthcareDrugLineDto[]
}

/**
 * Prices a basket of medications before checkout, with exactly the code create-intent
 * uses — so the total the customer sees is the total they are charged. The response's
 * `providerAmount` is what the client echoes back in the create-intent order.
 */
@Controller('payments/healthcare')
@UseGuards(HealthcareEnabledGuard)
export class HealthcareQuoteController {
  constructor(
    private readonly healthcare: HealthcareService,
    private readonly pricing: PricingService,
  ) {}

  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Post('quote')
  async quote(@Body() dto: HealthcareQuoteDto) {
    const currency = (dto.currency || 'usd').toLowerCase()

    let lines
    try {
      lines = await this.healthcare.resolveDrugLines(
        dto.drugs.map((d) => ({ drugName: d.drugName, quantity: d.quantity })),
      )
    } catch (error) {
      if (error instanceof NotFoundException) throw new UnprocessableEntityException(error.message)
      throw error
    }

    const providerAmount = Math.round(lines.reduce((s, l) => s + l.unitPrice * l.quantity, 0) * 100) / 100

    let amount: number
    try {
      amount = await this.pricing.chargeForHealthcareTotal(providerAmount, undefined, currency)
    } catch (error) {
      if (error instanceof PricingError) throw new HttpException(error.message, error.statusCode)
      throw error
    }

    const stripe = validateStripeAmount(amount, currency)
    const shortfallNgn = healthcareBasketShortfall(providerAmount)
    const payable = stripe.valid && shortfallNgn === 0
    const message = shortfallNgn > 0
      ? `Medicine orders must be at least ₦${HEALTHCARE_MIN_NGN.toLocaleString('en-NG')}`
      : stripe.error

    return {
      lines: lines.map((l) => ({
        drugName: l.drugName,
        quantity: l.quantity,
        unitPrice: l.unitPrice,
        lineTotal: Math.round(l.unitPrice * l.quantity * 100) / 100,
      })),
      providerAmount,
      providerCurrency: 'NGN',
      amount,
      currency: currency.toUpperCase(),
      // False when the basket is below HEALTHCARE_MIN_NGN or the card network minimum — the
      // UI asks the customer to add packs or items rather than let create-intent reject it.
      payable,
      minimumNgn: HEALTHCARE_MIN_NGN,
      shortfallNgn,
      ...(payable ? {} : { message }),
    }
  }
}
