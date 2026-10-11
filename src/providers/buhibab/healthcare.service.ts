import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { RedisService } from '../../common/redis.service'
import { getPlanetTalkUrl } from './planettalk.config'
import { PlanetTalkService } from './planettalk.service'
import type {
  HealthcareDrug,
  HealthcarePharmaciesResponse,
  HealthcarePharmacy,
  RawHealthcareDrug,
} from './healthcare.types'

const PHARMACIES_CACHE_KEY = 'planettalk:healthcare:pharmacies'
const PHARMACIES_CACHE_TTL_MS = 6 * 60 * 60 * 1000
// Shorter than Redis so each replica picks up a refreshed shared list within the hour.
const PHARMACIES_MEMORY_TTL_MS = 60 * 60 * 1000
// buhibab pages pharmacies 50 at a time (`page_index`, 1-based) and ignores any page-size
// parameter. ~8 pages today; the cap only guards against a runaway pageCount.
const MAX_PHARMACY_PAGES = 60

/** buhibab rejects shorter queries with a 422. */
export const DRUG_SEARCH_MIN_LENGTH = 4

export interface DrugLineRequest {
  drugName: string
  quantity: number
  dose?: string
}

export interface ResolvedDrugLine extends DrugLineRequest {
  /** NGN per pack, straight from the provider's drug search. */
  unitPrice: number
}

function toDrug(raw: RawHealthcareDrug): HealthcareDrug {
  return {
    drugName: raw.drugName,
    genericName: raw.genericName ?? null,
    brandName: raw.brandName ?? null,
    drugClass: raw.drugClass ?? null,
    dosageForm: raw.dosageForm ?? null,
    strength: raw.strength ?? null,
    packSize: raw.packSize ?? null,
    // Sold per pack: `drugPrice` is the pack price; `unitPrice` upstream is per tablet.
    price: Number(raw.drugPrice),
    currency: 'NGN',
  }
}

const byName = (a: string, b: string) => a.localeCompare(b, 'en', { sensitivity: 'base' })
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * buhibab Healthcare (WellaHealth pharmacy) lookups: pharmacy locations and drug search.
 * None of this is in buhibab's published Postman docs — shapes were established against
 * the live API on 2026-10-03. Purchase goes through the payments fulfilment engine
 * (PlanetTalkHealthcareExecutor), never from here.
 */
@Injectable()
export class HealthcareService {
  private readonly logger = new Logger(HealthcareService.name)
  private memPharmacies: { list: HealthcarePharmacy[]; expiresAt: number } | null = null

  constructor(
    private readonly planetTalk: PlanetTalkService,
    private readonly redis: RedisService,
  ) {}

  private async getJson<T>(path: string): Promise<{ status: number; body: T }> {
    let res: Response
    try {
      res = await this.planetTalk.fetch(`${getPlanetTalkUrl()}${path}`)
    } catch {
      throw new ServiceUnavailableException('The pharmacy service is unreachable. Please try again shortly.')
    }
    const body = (await res.json().catch(() => ({}))) as T
    if (res.status >= 500) {
      throw new ServiceUnavailableException('The pharmacy service is unavailable. Please try again shortly.')
    }
    return { status: res.status, body }
  }

  // ---------------------------------------------------------------------------
  // Pharmacies & locations
  // ---------------------------------------------------------------------------

  /**
   * Every pharmacy, cached in Redis. There is no states endpoint upstream and the LGA
   * endpoint only covers one level, so the location dropdowns are derived from this list
   * — which also guarantees every state/LGA/city offered actually has a pharmacy.
   */
  async getAllPharmacies(): Promise<HealthcarePharmacy[]> {
    // Memory first: every dropdown call lands here, and a Redis hiccup should not turn
    // each one into a full upstream refetch. Redis still shares the list across replicas.
    if (this.memPharmacies && this.memPharmacies.expiresAt > Date.now()) {
      return this.memPharmacies.list
    }

    const cached = await this.redis.get(PHARMACIES_CACHE_KEY)
    if (cached) {
      try {
        const list = JSON.parse(cached) as HealthcarePharmacy[]
        this.memPharmacies = { list, expiresAt: Date.now() + PHARMACIES_MEMORY_TTL_MS }
        return list
      } catch {
        // fall through and refetch
      }
    }

    const fetchPage = async (page: number) => {
      const { status, body } = await this.getJson<HealthcarePharmaciesResponse>(
        `/healthcare/pharmacies?page_index=${page}`,
      )
      if (status !== 200 || !Array.isArray(body.data)) {
        throw new ServiceUnavailableException('Unable to load pharmacies right now.')
      }
      return body
    }

    // Page 1 tells us the page count; the rest go out together. Sequentially this was ~6s
    // on a cold cache (~0.6s per page upstream) — too slow for a dropdown.
    const first = await fetchPage(1)
    const pageCount = Math.min(Number(first.pageCount) || 1, MAX_PHARMACY_PAGES)
    const rest = await Promise.all(
      Array.from({ length: pageCount - 1 }, (_, i) => fetchPage(i + 2)),
    )
    const all: HealthcarePharmacy[] = [first, ...rest].flatMap((p) => p.data)

    if (all.length > 0) {
      this.memPharmacies = { list: all, expiresAt: Date.now() + PHARMACIES_MEMORY_TTL_MS }
      await this.redis.setPx(PHARMACIES_CACHE_KEY, JSON.stringify(all), PHARMACIES_CACHE_TTL_MS)
    }
    return all
  }

  async listStates(): Promise<string[]> {
    const pharmacies = await this.getAllPharmacies()
    return [...new Set(pharmacies.map((p) => p.state.trim()))].sort(byName)
  }

  async listLgas(state: string): Promise<string[]> {
    const pharmacies = await this.getAllPharmacies()
    return [...new Set(pharmacies.filter((p) => sameText(p.state, state)).map((p) => p.lga.trim()))].sort(byName)
  }

  /** "City" in the product brief = buhibab's `area`. */
  async listCities(state: string, lga: string): Promise<string[]> {
    const pharmacies = await this.getAllPharmacies()
    return [
      ...new Set(
        pharmacies.filter((p) => sameText(p.state, state) && sameText(p.lga, lga)).map((p) => p.area.trim()),
      ),
    ].sort(byName)
  }

  async listPharmacies(filter: { state: string; lga?: string; city?: string }): Promise<HealthcarePharmacy[]> {
    const pharmacies = await this.getAllPharmacies()
    return pharmacies
      .filter(
        (p) =>
          sameText(p.state, filter.state) &&
          (!filter.lga || sameText(p.lga, filter.lga)) &&
          (!filter.city || sameText(p.area, filter.city)),
      )
      .sort((a, b) => byName(a.pharmacyName, b.pharmacyName))
  }

  async findPharmacy(pharmacyCode: string): Promise<HealthcarePharmacy | null> {
    const pharmacies = await this.getAllPharmacies()
    return pharmacies.find((p) => p.pharmacyCode === pharmacyCode) ?? null
  }

  // ---------------------------------------------------------------------------
  // Drugs
  // ---------------------------------------------------------------------------

  async searchDrugs(query: string): Promise<HealthcareDrug[]> {
    const q = (query ?? '').trim()
    if (q.length < DRUG_SEARCH_MIN_LENGTH) {
      throw new BadRequestException(`Search needs at least ${DRUG_SEARCH_MIN_LENGTH} characters`)
    }
    const { status, body } = await this.getJson<{ data?: RawHealthcareDrug[]; message?: string }>(
      `/healthcare/drugs/search?query=${encodeURIComponent(q.slice(0, 100))}`,
    )
    if (status !== 200) {
      throw new BadRequestException(body.message || 'Unable to search medications')
    }
    return (body.data ?? [])
      .filter((d) => d && typeof d.drugName === 'string' && Number(d.drugPrice) > 0)
      .map(toDrug)
  }

  /**
   * The provider's drug records carry no id, so the exact `drugName` is the key. Searching
   * by the full name was verified to return that exact record.
   */
  async findDrug(drugName: string): Promise<HealthcareDrug | null> {
    const results = await this.searchDrugs(drugName)
    return results.find((d) => d.drugName === drugName) ?? null
  }

  /**
   * Attach the live pack price to each requested line. Throws NotFoundException when a
   * medication is no longer listed — the client must not be able to name its own price.
   */
  async resolveDrugLines(lines: DrugLineRequest[]): Promise<ResolvedDrugLine[]> {
    const resolved: ResolvedDrugLine[] = []
    for (const line of lines) {
      const drug = await this.findDrug(line.drugName)
      if (!drug) {
        throw new NotFoundException(`"${line.drugName}" is no longer available`)
      }
      resolved.push({ ...line, unitPrice: drug.price })
    }
    return resolved
  }

  /**
   * NGN per USD for the pharmacy product, derived exactly as the other buhibab products
   * derive theirs (`value_amount / price`, see planettalk.mappers.ts).
   */
  async getProductFxRate(productId: number): Promise<number> {
    const { data } = await this.planetTalk.fetchRawProducts()
    const product = data.flatMap((g) => g.products).find((p) => p.id === productId)
    if (!product || !(product.price > 0) || !(product.value_amount > 0)) {
      this.logger.error(`Healthcare product ${productId} missing from buhibab /products`)
      throw new ServiceUnavailableException('Pharmacy purchases are temporarily unavailable')
    }
    return product.value_amount / product.price
  }
}
