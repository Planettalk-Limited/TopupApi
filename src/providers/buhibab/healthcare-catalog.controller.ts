import { BadRequestException, Controller, Get, Query, ServiceUnavailableException } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { HealthcareService } from './healthcare.service'
import { PlanetTalkService } from './planettalk.service'

/**
 * Healthcare (pharmacy) catalog for the checkout dropdowns. Nigeria-only, buhibab-only.
 *
 * Suggested flow: states -> lgas -> cities -> pharmacies (pick one, keep its
 * pharmacyCode) and, in any order, drugs/search -> POST /payments/healthcare/quote ->
 * POST /payments/create-intent with productType "healthcare".
 */
@Controller('planettalk/healthcare')
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

  private required(value: string | undefined, name: string): string {
    const v = value?.trim()
    if (!v) throw new BadRequestException(`${name} is required`)
    return v
  }

  @Get('states')
  async states() {
    this.assertConfigured()
    return this.healthcare.listStates()
  }

  @Get('lgas')
  async lgas(@Query('state') state?: string) {
    this.assertConfigured()
    return this.healthcare.listLgas(this.required(state, 'state'))
  }

  /** "City" in the product brief is buhibab's pharmacy `area`. */
  @Get('cities')
  async cities(@Query('state') state?: string, @Query('lga') lga?: string) {
    this.assertConfigured()
    return this.healthcare.listCities(this.required(state, 'state'), this.required(lga, 'lga'))
  }

  @Get('pharmacies')
  async pharmacies(@Query('state') state?: string, @Query('lga') lga?: string, @Query('city') city?: string) {
    this.assertConfigured()
    return this.healthcare.listPharmacies({
      state: this.required(state, 'state'),
      lga: lga?.trim() || undefined,
      city: city?.trim() || undefined,
    })
  }

  /** Each keystroke would be an upstream call — keep this tighter than the default. */
  @Throttle({ default: { limit: 30, ttl: 60_000 } })
  @Get('drugs/search')
  async searchDrugs(@Query('query') query?: string) {
    this.assertConfigured()
    return this.healthcare.searchDrugs(query ?? '')
  }
}
