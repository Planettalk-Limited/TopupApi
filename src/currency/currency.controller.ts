import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from '@nestjs/common'
import { CurrencyService } from './currency.service'

/**
 * Public FX conversion (display only). Ported 1:1 from TopupApp's
 * /api/currency/convert. No params → full GBP-based snapshot; with params →
 * a single pair conversion. No silent fallback — fails 503 if rates unavailable.
 */
@Controller('currency')
export class CurrencyController {
  constructor(private readonly currency: CurrencyService) {}

  @Get('convert')
  async convert(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('amount') amount?: string,
  ) {
    try {
      const { rates, timestamp } = await this.currency.getRatesGBP()

      if (!from && !to && !amount) {
        return { base: 'GBP', rates, timestamp }
      }

      const fromCurrency = from || 'USD'
      const toCurrency = to || 'USD'
      const amountValue = parseFloat(amount || '1')

      if (!rates[fromCurrency.toUpperCase()]) {
        throw new BadRequestException(`Currency rate not found: ${fromCurrency}`)
      }
      if (!rates[toCurrency.toUpperCase()]) {
        throw new BadRequestException(`Currency rate not found: ${toCurrency}`)
      }

      const rate = rates[toCurrency.toUpperCase()] / rates[fromCurrency.toUpperCase()]
      const convertedAmount = this.currency.convertWithRates(amountValue, fromCurrency, toCurrency, rates)

      return {
        from: fromCurrency,
        to: toCurrency,
        amount: amountValue,
        convertedAmount: Math.round(convertedAmount * 100) / 100,
        rate: Math.round(rate * 1_000_000) / 1_000_000,
        timestamp,
      }
    } catch (err) {
      if (err instanceof BadRequestException) throw err
      throw new ServiceUnavailableException(
        err instanceof Error ? err.message : 'Currency conversion failed',
      )
    }
  }
}
