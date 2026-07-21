import { Injectable, ServiceUnavailableException } from '@nestjs/common'
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
}
