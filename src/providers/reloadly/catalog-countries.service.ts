import { HttpException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { RedisService } from '../../common/redis.service'
import { resolveProvider } from '../../payments/order-metadata'
import { PlanetTalkService } from '../buhibab/planettalk.service'
import { ALLOWED_GIFT_CARD_PRODUCT_IDS } from './allowed-gift-card-products'
import { ReloadlyService } from './reloadly.service'

const UTILITIES_ACCEPT = 'application/com.reloadly.utilities-v1+json'
const GIFTCARDS_ACCEPT = 'application/com.reloadly.giftcards-v1+json'

/** Country pickers change rarely; six hours keeps them fresh enough without hammering Reloadly. */
export const COUNTRY_LIST_CACHE_TTL_MS = 6 * 60 * 60 * 1000
const GIFT_CARD_PAGE_SIZE = 200
const GIFT_CARD_MAX_PAGES = 50
const BILLER_LOOKUP_CONCURRENCY = 6

type Country = { isoName: string; [key: string]: unknown }

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const i = next++
      out[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

/**
 * Country lists for the Pay Utilities and Gift Cards pickers, restricted to countries we
 * can actually sell in (webmart review steps 8 and 14). Reloadly's own /countries lists
 * include countries with no billers (KE, UG) and countries with no curated gift cards.
 */
@Injectable()
export class CatalogCountriesService {
  private readonly logger = new Logger(CatalogCountriesService.name)

  constructor(
    private readonly reloadly: ReloadlyService,
    private readonly planetTalk: PlanetTalkService,
    private readonly redis: RedisService,
  ) {}

  private async getJson(api: 'utilities' | 'giftcards', path: string, accept: string): Promise<any> {
    const res = await this.reloadly.fetch(api, `${this.reloadly.getUrl(api)}${path}`, { headers: { Accept: accept } })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new HttpException({ error: `Reloadly request failed (${res.status})`, details: body.slice(0, 300) }, res.status)
    }
    return res.json()
  }

  private async cached<T>(key: string): Promise<T | null> {
    const raw = await this.redis.get(key)
    if (!raw) return null
    try {
      return JSON.parse(raw) as T
    } catch {
      return null
    }
  }

  /**
   * Reloadly's utility countries, minus those without billers. Nigeria follows the same
   * provider switch as checkout (TOPUP_PROVIDER_NG): with 'planettalk' it is judged by the
   * PlanetTalk biller list, which is what the frontend then shows for NG.
   */
  async utilityCountries(): Promise<Country[]> {
    const key = `reloadly:catalog:utility-countries:ng-${resolveProvider('NG', 'utility')}`
    const hit = await this.cached<Country[]>(key)
    if (hit) return hit

    const countries = await this.getJson('utilities', '/countries', UTILITIES_ACCEPT)
    if (!Array.isArray(countries)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }

    let incomplete = false
    const hasBillers = await mapLimit(countries as Country[], BILLER_LOOKUP_CONCURRENCY, async (c) => {
      try {
        if (resolveProvider(c.isoName, 'utility') === 'planettalk') {
          return (await this.planetTalk.fetchAndBuildBillers()).length > 0
        }
        const billers = await this.getJson('utilities', `/billers?countryISOCode=${c.isoName}&size=1`, UTILITIES_ACCEPT)
        const list = Array.isArray(billers) ? billers : billers?.content
        return Array.isArray(list) && list.length > 0
      } catch (error) {
        // Leave it out this time, but do not cache a list missing a country by accident.
        incomplete = true
        this.logger.warn(`Biller lookup failed for ${c.isoName}: ${(error as Error).message}`)
        return false
      }
    })

    const filtered = (countries as Country[]).filter((_, i) => hasBillers[i])
    if (!incomplete) {
      await this.redis.setPx(key, JSON.stringify(filtered), COUNTRY_LIST_CACHE_TTL_MS)
    }
    return filtered
  }

  /** Gift-card countries that have at least one product on the curated allow-list. */
  async giftCardCountries(): Promise<Array<{ isoName: string; name: string; flagUrl: string }>> {
    const key = 'reloadly:catalog:gift-card-countries'
    const hit = await this.cached<Array<{ isoName: string; name: string; flagUrl: string }>>(key)
    if (hit) return hit

    const countries = await this.getJson('giftcards', '/countries', GIFTCARDS_ACCEPT)
    if (!Array.isArray(countries)) {
      throw new ServiceUnavailableException('Invalid response format from Reloadly API')
    }
    const slim = (countries as Array<{ isoName: string; name: string; flagUrl: string }>).map((c) => ({
      isoName: c.isoName,
      name: c.name,
      flagUrl: c.flagUrl,
    }))

    let withProducts: Set<string>
    try {
      withProducts = await this.giftCardCountryCodes()
    } catch (error) {
      // Degrade to the unfiltered list (the per-country product call still filters), uncached.
      this.logger.warn(`Gift-card product scan failed, serving unfiltered countries: ${(error as Error).message}`)
      return slim
    }

    const filtered = slim.filter((c) => withProducts.has(String(c.isoName).toUpperCase()))
    await this.redis.setPx(key, JSON.stringify(filtered), COUNTRY_LIST_CACHE_TTL_MS)
    return filtered
  }

  /** ISO codes of every country that has an allow-listed product (scans Reloadly's paginated catalog). */
  private async giftCardCountryCodes(): Promise<Set<string>> {
    const codes = new Set<string>()
    for (let page = 1; page <= GIFT_CARD_MAX_PAGES; page++) {
      const body = await this.getJson('giftcards', `/products?size=${GIFT_CARD_PAGE_SIZE}&page=${page}`, GIFTCARDS_ACCEPT)
      const content: Array<{ productId: number; country?: { isoName?: string } }> = Array.isArray(body)
        ? body
        : (body?.content ?? [])
      for (const product of content) {
        const iso = product.country?.isoName
        if (iso && ALLOWED_GIFT_CARD_PRODUCT_IDS.has(Number(product.productId))) codes.add(iso.toUpperCase())
      }
      if (Array.isArray(body) || body?.last !== false || content.length === 0) break
    }
    return codes
  }
}
