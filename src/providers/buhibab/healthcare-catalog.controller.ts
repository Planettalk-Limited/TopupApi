import { Controller, Get, Query, ServiceUnavailableException, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { HealthcareEnabledGuard } from '../../common/healthcare-enabled'
import { HealthcareService } from './healthcare.service'
import { PlanetTalkService } from './planettalk.service'

/**
 * Healthcare (pharmacy) catalog. Nigeria-only, buhibab-only.
 *
 * Flow: drugs/search -> POST /payments/healthcare/quote -> POST /payments/create-intent
 * with productType "healthcare". No pharmacy is chosen: WellaHealth routes each order.
 */
@Controller('planettalk/healthcare')
@UseGuards(HealthcareEnabledGuard)
export class HealthcareCatalogController {
  constructor(
    private readonly healthcare: HealthcareService,
    private readonly planettalk: PlanetTalkService,
  ) {}

  private assertConfigured() {
    if (!this.planettalk.hasCredentials()) {
      throw new ServiceUnavailableException('Planet Talk API credentials not configured')
    }
  }

  /** Each keystroke would be an upstream call — keep this tighter than the default. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('drugs/search')
  async searchDrugs(@Query('query') query?: string) {
    this.assertConfigured()
    return this.healthcare.searchDrugs(query ?? '')
  }
}
