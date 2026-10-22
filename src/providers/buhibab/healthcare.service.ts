import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { getPlanetTalkUrl } from './planettalk.config'
import { PlanetTalkService } from './planettalk.service'
import type { HealthcareDrug, RawHealthcareDrug } from './healthcare.types'

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

/**
 * buhibab Healthcare (WellaHealth pharmacy) lookups: drug search and the product FX rate.
 * There is no pharmacy or location lookup: since 2026-10-16 an order names no pharmacy and
 * WellaHealth routes it to one near the delivery address. Purchase goes through the
 * payments fulfilment engine (PlanetTalkHealthcareExecutor), never from here.
 */
@Injectable()
export class HealthcareService {
  private readonly logger = new Logger(HealthcareService.name)

  constructor(private readonly planetTalk: PlanetTalkService) {}

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
