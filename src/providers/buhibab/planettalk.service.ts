import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common'
import { RedisService } from '../../common/redis.service'
import {
  PLANETTALK_CONFIG,
  getPlanetTalkUrl,
  hasPlanetTalkCredentials,
} from './planettalk.config'
import {
  buildBillersFromProducts,
  buildOperatorsFromProducts,
  type BuildResult,
  type MappedBiller,
} from './planettalk.mappers'
import type { PlanetTalkAuthResponse, PlanetTalkProductsResponse } from './planettalk.types'

const TOKEN_KEY = 'planettalk:token'
// Module-level rather than an instance field so it also exists on instances built without
// the constructor (the verify specs create the service from its prototype).
const logger = new Logger('PlanetTalkService')

export type MeterType = 'prepaid' | 'postpaid'

export type AccountVerifyResult =
  | { valid: true; customerName: string | null }
  | { valid: false; message: string }

export interface VerifyAccountInput {
  productId: number
  billersCode: string
  meterType?: MeterType
}

// --- Account-holder name extraction (verify-meter / verify-smartcard) ----------------
// Buhibab has returned the name under several keys and nestings (root, `data`, `content`,
// `data.details`, `customer.name` …) and changes shape without notice. Search the whole
// response — bounded — rather than a fixed list of paths, but only trust name-like keys,
// and never descend into product/biller-ish objects whose `name` is not a person.

const NAME_SEARCH_MAX_DEPTH = 6
const NAME_SEARCH_MAX_NODES = 500

/** Keys that unambiguously hold the account holder's name (normalised: lower-case, alnum only). */
const EXPLICIT_NAME_KEYS = new Set([
  'customername',
  'customerfullname',
  'accountname',
  'accountholdername',
  'holdername',
  'ownername',
  'subscribername',
  'nameofcustomer',
  'fullname',
])
/** Objects whose bare `name` is a person (customer.name, account.holder.name …). */
const PERSON_CONTAINERS = new Set(['customer', 'account', 'accountholder', 'holder', 'owner', 'subscriber', 'client', 'user'])
/** Generic response wrappers — a bare `name` here is the subject of the response. */
const WRAPPER_CONTAINERS = new Set(['', 'data', 'content', 'result', 'results', 'response', 'details', 'payload', 'info'])
/** Never searched: their `name` is a product, biller, plan … not the account holder. */
const NON_PERSON_CONTAINERS = new Set([
  'product',
  'products',
  'biller',
  'billers',
  'service',
  'services',
  'operator',
  'merchant',
  'provider',
  'package',
  'plan',
  'bouquet',
  'vendor',
  'disco',
  'company',
  'tariff',
  'category',
  'bank',
])

const normKey = (key: string) => key.toLowerCase().replace(/[^a-z0-9]/g, '')

function asName(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > 200) return null
  // A meter/account number echoed back under a name key is not a name.
  if (/^[\d\s-]+$/.test(trimmed)) return null
  return trimmed
}

type NameNode = { value: Record<string, unknown>; container: string; depth: number }

/** Breadth-first walk of plain objects (arrays inherit their key), shallowest first, bounded. */
function walkObjects(body: Record<string, unknown>): NameNode[] {
  const out: NameNode[] = []
  const queue: Array<{ value: unknown; container: string; depth: number }> = [{ value: body, container: '', depth: 0 }]
  while (queue.length > 0 && out.length < NAME_SEARCH_MAX_NODES) {
    const { value, container, depth } = queue.shift()!
    if (depth > NAME_SEARCH_MAX_DEPTH || !value || typeof value !== 'object') continue
    if (Array.isArray(value)) {
      value.slice(0, 20).forEach((item) => queue.push({ value: item, container, depth: depth + 1 }))
      continue
    }
    const obj = value as Record<string, unknown>
    out.push({ value: obj, container, depth })
    for (const [key, child] of Object.entries(obj)) {
      const k = normKey(key)
      if (NON_PERSON_CONTAINERS.has(k)) continue
      if (child && typeof child === 'object') queue.push({ value: child, container: k, depth: depth + 1 })
    }
  }
  return out
}

/** Pull a customer/account-holder name out of whatever shape Buhibab returned, or null. */
export function extractCustomerName(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const nodes = walkObjects(body as Record<string, unknown>)

  // Pass 1: an explicit customer/account-name key anywhere (shallowest wins).
  for (const { value } of nodes) {
    for (const [key, v] of Object.entries(value)) {
      if (EXPLICIT_NAME_KEYS.has(normKey(key))) {
        const name = asName(v)
        if (name) return name
      }
    }
  }

  // Pass 2: a bare `name` (or first + last) — only where it describes a person or the
  // response itself, never e.g. product.name.
  for (const { value, container } of nodes) {
    const personish = PERSON_CONTAINERS.has(container)
    if (!personish && !WRAPPER_CONTAINERS.has(container)) continue
    const keys = new Map(Object.keys(value).map((k) => [normKey(k), k]))
    const bare = keys.has('name') ? asName(value[keys.get('name')!]) : null
    if (bare) return bare
    if (personish) {
      const first = keys.has('firstname') ? asName(value[keys.get('firstname')!]) : null
      const last = keys.has('lastname') ? asName(value[keys.get('lastname')!]) : null
      if (first || last) return [first, last].filter(Boolean).join(' ')
    }
  }
  return null
}

/**
 * Keys-only outline of a response, e.g. `{data:{meter,owner:{line1}},message}` — for
 * diagnosing a provider shape change without ever logging values (names, meter numbers).
 */
export function describeKeyShape(value: unknown, depth = 0): string {
  if (Array.isArray(value)) {
    return `[${value.length > 0 ? describeKeyShape(value[0], depth + 1) : ''}]`
  }
  if (!value || typeof value !== 'object') return ''
  if (depth >= 5) return '{…}'
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.slice(0, 30).map((key) => {
    // Keys themselves are provider-defined identifiers; cap their length defensively.
    const safeKey = key.replace(/[^\w.-]/g, '').slice(0, 40)
    const child = (value as Record<string, unknown>)[key]
    return child && typeof child === 'object' ? `${safeKey}:${describeKeyShape(child, depth + 1)}` : safeKey
  })
  if (keys.length > 30) parts.push('…')
  return `{${parts.join(',')}}`
}
function verifyKindForBiller(biller: MappedBiller): 'meter' | 'smartcard' | null {
  const type = (biller.type || '').toUpperCase()
  if (type.includes('ELECTRIC') || type.includes('POWER') || type.includes('ENERGY')) return 'meter'
  if (type.includes('TV') || type.includes('CABLE') || type.includes('SATELLITE') || type.includes('DTH')) {
    return 'smartcard'
  }
  return null
}

/**
 * buhibab ("PlanetTalk") provider adapter. Ports TopupApp's planettalk-auth.ts
 * + the fetch-and-build helpers. Token cache is Redis-backed (shared across
 * replicas) rather than per-process; the provider returns an absolute
 * `expires_at`, so the Redis TTL is derived from that minus a refresh buffer.
 */
@Injectable()
export class PlanetTalkService {
  constructor(private readonly redis: RedisService) {}

  hasCredentials = hasPlanetTalkCredentials

  /**
   * buhibab allows ONE live token per account: every login revokes the previous token
   * (verified 2026-10-03). So concurrent logins are self-defeating — each one 401s the
   * others, which then log in again. Hence: a single in-flight login per process, an
   * in-memory copy of the token (so a Redis outage doesn't mean a login per request), and
   * a 401 retry that only re-logs-in when the rejected token is still the current one.
   */
  private memToken: { token: string; expiresAt: number } | null = null
  private inflightLogin: Promise<string> | null = null

  private async currentToken(): Promise<string | null> {
    const cached = await this.redis.get(TOKEN_KEY)
    if (cached) return cached
    if (this.memToken && this.memToken.expiresAt > Date.now()) return this.memToken.token
    return null
  }

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const current = await this.currentToken()
      if (current) return current
    }

    if (!this.inflightLogin) {
      this.inflightLogin = this.login().finally(() => {
        this.inflightLogin = null
      })
    }
    return this.inflightLogin
  }

  private async login(): Promise<string> {
    const { email, password } = PLANETTALK_CONFIG.credentials
    if (!email || !password) {
      throw new ServiceUnavailableException('Planet Talk API credentials not configured')
    }

    const basicAuth = Buffer.from(`${email}:${password}`).toString('base64')
    const res = await fetch(`${getPlanetTalkUrl()}/auth/token`, {
      method: 'POST',
      headers: { Accept: 'application/json', Authorization: `Basic ${basicAuth}` },
      body: new URLSearchParams({ country: PLANETTALK_CONFIG.country }),
    })

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      throw new ServiceUnavailableException(
        `Planet Talk authentication failed: ${JSON.stringify(errorData)}`,
      )
    }

    const data = (await res.json()) as PlanetTalkAuthResponse
    const ttlMs = new Date(data.expires_at).getTime() - Date.now() - PLANETTALK_CONFIG.token.refreshBuffer
    if (ttlMs > 1000) {
      this.memToken = { token: data.token, expiresAt: Date.now() + ttlMs }
      await this.redis.setPx(TOKEN_KEY, data.token, ttlMs)
    } else {
      this.memToken = null
    }
    return data.token
  }

  /** Fetch a PlanetTalk endpoint with bearer auth, retrying once on 401. */
  async fetch(url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getToken()
    const headers = (t: string) => ({
      ...(options.headers ?? {}),
      Authorization: `Bearer ${t}`,
      Accept: 'application/json',
    })

    let res = await fetch(url, { ...options, headers: headers(token) })
    if (res.status === 401) {
      // If someone else already replaced the token we were rejected with, use theirs —
      // logging in again would revoke it and 401 every request currently using it.
      const current = await this.currentToken()
      const fresh = current && current !== token ? current : await this.getToken(true)
      res = await fetch(url, { ...options, headers: headers(fresh) })
    }
    return res
  }

  private async fetchProducts(): Promise<PlanetTalkProductsResponse> {
    const res = await this.fetch(`${getPlanetTalkUrl()}/products`)
    if (!res.ok) {
      const err = await res.json().catch(() => ({}) as { message?: string })
      throw new ServiceUnavailableException(
        (err as { message?: string }).message || `Planet Talk API error ${res.status}`,
      )
    }
    return (await res.json()) as PlanetTalkProductsResponse
  }

  async fetchRawProducts(subService?: string): Promise<PlanetTalkProductsResponse> {
    const result = await this.fetchProducts()
    if (subService) {
      return {
        message: result.message,
        data: result.data.filter(
          (g) => g.sub_service.name.toLowerCase() === subService.toLowerCase(),
        ),
      }
    }
    return result
  }

  async fetchAndBuildBillers(): Promise<MappedBiller[]> {
    const body = await this.fetchProducts()
    return buildBillersFromProducts(body.data)
  }

  async fetchAndBuildOperators(): Promise<BuildResult> {
    const body = await this.fetchProducts()
    return buildOperatorsFromProducts(body.data)
  }

  /**
   * Verify a Nigeria electricity meter or cable-TV smartcard via Buhibab before
   * checkout. productId is the PlanetTalk product / mapped-biller id.
   */
  async verifyAccount(input: VerifyAccountInput): Promise<AccountVerifyResult> {
    if (!this.hasCredentials()) {
      throw new ServiceUnavailableException('Planet Talk API credentials not configured')
    }

    const billersCode = input.billersCode?.trim()
    if (!billersCode) {
      throw new BadRequestException('billersCode is required')
    }

    const billers = await this.fetchAndBuildBillers()
    const biller = billers.find((b) => b.id === input.productId)
    if (!biller) {
      throw new NotFoundException('Biller / product not found')
    }

    const kind = verifyKindForBiller(biller)
    if (!kind) {
      throw new BadRequestException(
        'Account verification is only available for Electricity and Cable TV products',
      )
    }

    const formData = new FormData()
    formData.append('billersCode', billersCode)
    if (kind === 'meter') {
      formData.append('type', input.meterType === 'postpaid' ? 'postpaid' : 'prepaid')
    }

    const path =
      kind === 'meter'
        ? `/products/${biller.id}/verify-meter`
        : `/products/${biller.id}/verify-smartcard`

    let res: Response
    try {
      res = await this.fetch(`${getPlanetTalkUrl()}${path}`, {
        method: 'POST',
        body: formData,
      })
    } catch (networkErr) {
      throw new ServiceUnavailableException(
        'We could not reach the verification service. Please try again in a moment.',
      )
    }

    const body = await res.json().catch(() => ({} as Record<string, unknown>))

    if (!res.ok) {
      const message =
        (typeof body === 'object' && body && 'message' in body && typeof (body as any).message === 'string'
          ? (body as { message: string }).message
          : null) || 'Unable to verify this account number'
      // Provider validation failures (invalid meter/smartcard) are expected user
      // errors — surface as valid:false rather than 5xx.
      if (res.status >= 400 && res.status < 500) {
        return { valid: false, message }
      }
      throw new ServiceUnavailableException(
        'We could not verify this account right now. Please try again in a moment.',
      )
    }

    const customerName = extractCustomerName(body)
    if (!customerName) {
      // Verified but no recognisable name: log the response's key shape (never values,
      // which include the holder's name / meter number) so the next miss is diagnosable.
      logger.warn(
        `Verify succeeded for product ${biller.id} (${kind}) but no account name was found; ` +
          `response keys: ${describeKeyShape(body)}`,
      )
    }
    return { valid: true, customerName }
  }
}
