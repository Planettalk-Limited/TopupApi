import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Post,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common'
import { VerifyAccountDto } from './dto/verify-account.dto'
import { PlanetTalkService } from './planettalk.service'

/**
 * buhibab ("PlanetTalk") catalog + pre-purchase verify endpoints.
 * Nigeria-only. Purchase still goes through the payments fulfillment engine.
 */
@Controller('planettalk')
export class PlanetTalkCatalogController {
  constructor(private readonly planettalk: PlanetTalkService) {}

  private assertNg(countryCode?: string) {
    if (!countryCode || countryCode.toUpperCase() !== 'NG') {
      throw new BadRequestException('Planet Talk is only available for Nigeria (NG)')
    }
  }

  private assertConfigured() {
    if (!this.planettalk.hasCredentials()) {
      throw new ServiceUnavailableException('Planet Talk API credentials not configured')
    }
  }

  @Get('billers')
  async billers(@Query('countryCode') countryCode?: string) {
    this.assertNg(countryCode)
    this.assertConfigured()
    const billers = await this.planettalk.fetchAndBuildBillers()
    if (billers.length === 0) {
      throw new NotFoundException('No utility billers available from Planet Talk')
    }
    return billers
  }

  @Get('operators')
  async operators(@Query('countryCode') countryCode?: string) {
    this.assertNg(countryCode)
    this.assertConfigured()
    const { operators } = await this.planettalk.fetchAndBuildOperators()
    if (operators.length === 0) {
      throw new NotFoundException('No operators available from Planet Talk')
    }
    return operators
  }

  @Get('products')
  async products(@Query('subService') subService?: string) {
    this.assertConfigured()
    return this.planettalk.fetchRawProducts(subService)
  }

  /**
   * Hard-gate helper for NG electricity meters / cable smartcards.
   * Always returns `{ valid, customerName? | message? }` for 4xx provider
   * validation outcomes so the client can block Continue without treating
   * a bad meter as a transport error.
   */
  @Post('verify-account')
  async verifyAccount(@Body() body: VerifyAccountDto) {
    this.assertConfigured()
    return this.planettalk.verifyAccount({
      productId: body.productId,
      billersCode: body.billersCode,
      meterType: body.meterType,
    })
  }
}
