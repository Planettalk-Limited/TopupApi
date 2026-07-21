import {
  BadRequestException,
  Controller,
  Get,
  NotFoundException,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'

/**
 * buhibab ("PlanetTalk") read-only catalog endpoints, ported 1:1 from
 * TopupApp's src/app/api/planettalk/** GET routes. Nigeria-only. Purchase
 * routes move with the fulfillment engine in Phase 4.
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
}
