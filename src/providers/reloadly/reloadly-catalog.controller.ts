import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Query,
  ServiceUnavailableException,
} from '@nestjs/common'
import { ReloadlyService } from './reloadly.service'
import { ALLOWED_GIFT_CARD_PRODUCT_IDS } from './allowed-gift-card-products'

const TOPUPS_ACCEPT = 'application/com.reloadly.topups-v1+json'
const UTILITIES_ACCEPT = 'application/com.reloadly.utilities-v1+json'
const GIFTCARDS_ACCEPT = 'application/com.reloadly.giftcards-v1+json'

/**
 * Reloadly read-only catalog endpoints, ported 1:1 from TopupApp's
 * src/app/api/reloadly/** GET routes so the frontend can repoint unchanged.
 * All mutating (purchase) routes stay out of Phase 2 — those move with the
 * fulfillment engine in Phase 4.
 */
@Controller('reloadly')
export class ReloadlyCatalogController {
  constructor(private readonly reloadly: ReloadlyService) {}

  private assertConfigured() {
    if (!this.reloadly.hasCredentials()) {
      throw new ServiceUnavailableException('Reloadly API credentials not configured')
    }
  }

  private async getArray(api: 'topups' | 'utilities' | 'giftcards', path: string, accept: string) {
    const res = await this.reloadly.fetch(api, `${this.reloadly.getUrl(api)}${path}`, {
      headers: { Accept: accept },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HttpException(
        { error: `Reloadly request failed (${res.status})`, details: body.slice(0, 300) },
        res.status,
      )
    }
    return res.json()
  }

  @Get('operators')
  async operators(@Query('countryCode') countryCode?: string) {
    if (!countryCode) throw new BadRequestException('Country code is required')
    this.assertConfigured()
    const operators = await this.getArray('topups', `/operators/countries/${countryCode}`, TOPUPS_ACCEPT)
    if (!Array.isArray(operators)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    return operators
  }

  @Get('operators/auto-detect')
  async autoDetect(@Query('phone') phone?: string, @Query('countryCode') countryCode?: string) {
    if (!phone) throw new BadRequestException('Phone number is required')
    if (!countryCode) throw new BadRequestException('Country code is required')
    this.assertConfigured()

    const cleanPhone = phone.replace(/[\s\-+()]/g, '')
    const res = await this.reloadly.fetch(
      'topups',
      `${this.reloadly.getUrl('topups')}/operators/auto-detect/phone/${cleanPhone}/countries/${countryCode}`,
      { headers: { Accept: TOPUPS_ACCEPT } },
    )

    if (!res.ok) {
      const text = await res.text().catch(() => '')
      let details: unknown
      try {
        details = JSON.parse(text)
      } catch {
        details = { message: text }
      }
      if (res.status === 404) {
        // Preserve the exact shape the frontend keys off.
        throw new HttpException(
          { error: 'Operator not found for this number', code: 'OPERATOR_NOT_FOUND', details },
          HttpStatus.NOT_FOUND,
        )
      }
      throw new HttpException({ error: `Failed to auto-detect operator (${res.status})`, details }, res.status)
    }

    return { success: true, operator: await res.json() }
  }

  @Get('topup-countries')
  async topupCountries() {
    this.assertConfigured()
    const countries = await this.getArray('topups', '/countries', TOPUPS_ACCEPT)
    if (!Array.isArray(countries)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    return countries
  }

  @Get('utility-countries')
  async utilityCountries() {
    this.assertConfigured()
    const countries = await this.getArray('utilities', '/countries', UTILITIES_ACCEPT)
    if (!Array.isArray(countries)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    return countries
  }

  @Get('billers')
  async billers(@Query('countryCode') countryCode?: string, @Query('type') type?: string) {
    if (!countryCode) throw new BadRequestException('Country code is required')
    this.assertConfigured()
    let path = `/billers?countryISOCode=${countryCode}`
    if (type) path += `&type=${type}`
    const billers = await this.getArray('utilities', path, UTILITIES_ACCEPT)
    // Reloadly returns either an array or a paginated { content: [...] }.
    return Array.isArray(billers) ? billers : (billers?.content ?? [])
  }

  @Get('countries')
  async giftCardCountriesRaw() {
    this.assertConfigured()
    const countries = await this.getArray('giftcards', '/countries', GIFTCARDS_ACCEPT)
    if (!Array.isArray(countries)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    return countries
  }

  @Get('gift-cards/countries')
  async giftCardCountries() {
    this.assertConfigured()
    const countries = await this.getArray('giftcards', '/countries', GIFTCARDS_ACCEPT)
    return (countries as Array<{ isoName: string; name: string; flagUrl: string }>).map((c) => ({
      isoName: c.isoName,
      name: c.name,
      flagUrl: c.flagUrl,
    }))
  }

  @Get('gift-cards')
  async giftCards(@Query('countryCode') countryCode?: string) {
    if (!countryCode) throw new BadRequestException('Country code is required')
    this.assertConfigured()
    const products = await this.getArray(
      'giftcards',
      `/countries/${countryCode}/products`,
      GIFTCARDS_ACCEPT,
    )
    if (!Array.isArray(products)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    return products.filter((card: { productId: number }) =>
      ALLOWED_GIFT_CARD_PRODUCT_IDS.has(card.productId),
    )
  }
}
