import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'
import type { PlanetTalkProduct } from './planettalk.types'

/** buhibab sub-service holding the SureGifts vouchers (app_service 4, enabled 2026-10-19). */
export const VOUCHER_SUB_SERVICE = 'Gift Vouchers'

/**
 * Upper bound on a voucher's face value. buhibab lists every voucher as open-amount with a
 * minimum and no maximum (`value_amount_max: null`), so this is our exposure control,
 * roughly GBP 50 — the same ceiling as pharmacy orders.
 */
export const VOUCHER_MAX_NGN = Number(process.env.VOUCHER_MAX_NGN || 100_000)

export type VoucherCategory = 'groceries' | 'gift'
export const VOUCHER_CATEGORIES: readonly VoucherCategory[] = ['groceries', 'gift']

/** buhibab's provider category for supermarket vouchers. */
const GROCERIES_TAG = 'Groceries'
/**
 * A brand tagged with this many categories is a catch-all voucher (e.g. "Suregifts
 * Generic", tagged with every category), not a grocery store, so it stays a gift voucher.
 */
const CATCH_ALL_TAG_COUNT = 6

/**
 * Fallback for products without `operator_categories` (buhibab added the field on
 * 2026-10-19): recognise supermarkets by brand — names that say what they are, plus chains
 * whose names don't. Brands are listed exactly as buhibab names them (case-insensitive).
 */
const GROCERY_NAME_RE = /supermarket|superstore|grocer|foodstuff|whole foods|\bmart\b|cash and carry/i
const GROCERY_BRANDS = new Set(
  [
    'SPAR',
    'Justrite',
    'Grand Square',
    'Market Square',
    'Green Baskit',
    'PricePally',
    'The Food Hub',
    'Eden-Acres Organic Farm',
    'Olmart Stores',
    'ASHAKA SENIOR STAFF COP. SHOP',
  ].map((b) => b.toLowerCase()),
)

/**
 * Groceries are the brands buhibab tags "Groceries" (bar catch-all vouchers); everything
 * else is a gift voucher. Untagged products fall back to recognising the brand by name.
 */
export function voucherCategory(brand: string, tags?: string[]): VoucherCategory {
  if (tags && tags.length > 0) {
    return tags.includes(GROCERIES_TAG) && tags.length < CATCH_ALL_TAG_COUNT ? 'groceries' : 'gift'
  }
  const name = brand.trim()
  return GROCERY_BRANDS.has(name.toLowerCase()) || GROCERY_NAME_RE.test(name) ? 'groceries' : 'gift'
}

export interface Voucher {
  id: number
  name: string
  category: VoucherCategory
  /** buhibab's own categories for the brand, e.g. ["Beauty & Wellness"]. */
  tags: string[]
  /** Who issues the voucher — "SureGifts" for every product today. */
  supplier: string
  logo: string | null
  /** Face value bounds in NGN. */
  minAmount: number
  maxAmount: number
  currency: 'NGN'
  /** NGN per USD for this product (`value_amount / price`), as for every buhibab product. */
  fxRate: number
}

function toVoucher(p: PlanetTalkProduct): Voucher | null {
  if (!(p.value_amount > 0) || !(p.price > 0)) return null
  const upstreamMax = p.value_amount_max && p.value_amount_max > 0 ? p.value_amount_max : Infinity
  const maxAmount = Math.min(upstreamMax, VOUCHER_MAX_NGN)
  // A brand whose minimum is already above our cap cannot be sold.
  if (maxAmount < p.value_amount) return null
  return {
    id: p.id,
    name: p.name.trim(),
    category: voucherCategory(p.name, p.operator_categories),
    tags: (p.operator_categories ?? []).filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim()),
    supplier: p.operator_name,
    // The product's own image. Not operator_logo: the operator is SureGifts for every voucher,
    // so its logo would put the same mark on every brand.
    logo: p.image_url?.trim() || null,
    minAmount: p.value_amount,
    maxAmount,
    currency: 'NGN',
    fxRate: p.value_amount / p.price,
  }
}

/**
 * Nigerian gift vouchers (SureGifts) from buhibab's product list. Purchase goes through
 * the payments fulfilment engine (PlanetTalkVoucherExecutor), never from here.
 */
/**
 * How long a fetched catalog is reused. Every quote and checkout re-prices against the
 * catalog, and buhibab only exposes it as the full multi-hundred-product list, so a short
 * cache keeps a customer typing amounts from refetching it on every keystroke. Pricing
 * stays bound to provider data no older than this.
 */
const CATALOG_TTL_MS = 60_000

@Injectable()
export class VoucherService {
  private cache: { at: number; vouchers: Promise<Voucher[]> } | null = null

  constructor(private readonly planetTalk: PlanetTalkService) {}

  private loadAll(): Promise<Voucher[]> {
    if (this.cache && Date.now() - this.cache.at < CATALOG_TTL_MS) return this.cache.vouchers
    const vouchers = this.planetTalk.fetchRawProducts(VOUCHER_SUB_SERVICE).then(({ data }) =>
      data
        .flatMap((g) => g.products)
        .map(toVoucher)
        .filter((v): v is Voucher => v !== null)
        .sort((a, b) => a.name.localeCompare(b.name)),
    )
    this.cache = { at: Date.now(), vouchers }
    // A failed fetch must not be served from cache for the next minute.
    vouchers.catch(() => {
      if (this.cache?.vouchers === vouchers) this.cache = null
    })
    return vouchers
  }

  async listVouchers(category?: VoucherCategory): Promise<Voucher[]> {
    const all = await this.loadAll()
    return category ? all.filter((v) => v.category === category) : all
  }

  async findVoucher(productId: number): Promise<Voucher | null> {
    const vouchers = await this.listVouchers()
    return vouchers.find((v) => v.id === productId) ?? null
  }
}
