import {
  BadRequestException,
  Injectable,
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

export type MeterType = 'prepaid' | 'postpaid'

export type AccountVerifyResult =
  | { valid: true; customerName: string | null }
  | { valid: false; message: string }

export interface VerifyAccountInput {
  productId: number
  billersCode: string
  meterType?: MeterType
}

/** Pull a customer/account-holder name out of the various shapes Buhibab has returned. */
export function extractCustomerName(body: unknown): string | null {
  if (!body || typeof body !== 'object') return null
  const root = body as Record<string, unknown>
  const candidates: unknown[] = [
    root.customerName,
    root.customer_name,
    root.Customer_Name,
    root.name,
    (root.data as Record<string, unknown> | undefined)?.customerName,
    (root.data as Record<string, unknown> | undefined)?.customer_name,
    (root.data as Record<string, unknown> | undefined)?.Customer_Name,
    (root.data as Record<string, unknown> | undefined)?.name,
    (root.content as Record<string, unknown> | undefined)?.Customer_Name,
    (root.content as Record<string, unknown> | undefined)?.customer_name,
    (root.content as Record<string, unknown> | undefined)?.customerName,
    (root.content as Record<string, unknown> | undefined)?.name,
  ]
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
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

  async getToken(forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.redis.get(TOKEN_KEY)
      if (cached) return cached
    }

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
      await this.redis.setPx(TOKEN_KEY, data.token, ttlMs)
    }
    return data.token
  }

  private async clearToken() {
    await this.redis.del(TOKEN_KEY)
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
      await this.clearToken()
      const fresh = await this.getToken(true)
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

    return { valid: true, customerName: extractCustomerName(body) }
  }
}
