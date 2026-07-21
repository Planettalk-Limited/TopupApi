import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common'
import { RedisService } from '../../common/redis.service'
import {
  RELOADLY_CONFIG,
  ReloadlyApi,
  getReloadlyAudience,
  getReloadlyUrl,
  hasReloadlyCredentials,
} from './reloadly.config'

/**
 * Reloadly provider adapter. Ports TopupApp's reloadly-auth.ts + reloadly-balance.ts.
 *
 * Difference from the original: the OAuth token cache is Redis-backed (keyed per
 * audience) instead of per-process module state, so multiple TopupApi replicas
 * share one token per audience rather than each re-authenticating. Redis
 * failures degrade gracefully to a fresh token fetch.
 */
@Injectable()
export class ReloadlyService {
  private readonly logger = new Logger(ReloadlyService.name)

  constructor(private readonly redis: RedisService) {}

  getUrl = getReloadlyUrl
  getAudience = getReloadlyAudience
  hasCredentials = hasReloadlyCredentials
  get isSandbox() {
    return RELOADLY_CONFIG.isSandbox
  }

  private tokenKey(api: ReloadlyApi): string {
    return `reloadly:token:${api}`
  }

  /** Get a valid access token for the given audience, using the shared cache. */
  async getToken(api: ReloadlyApi = 'giftcards', forceRefresh = false): Promise<string> {
    if (!forceRefresh) {
      const cached = await this.redis.get(this.tokenKey(api))
      if (cached) return cached
    }

    const res = await fetch(RELOADLY_CONFIG.urls.auth, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: RELOADLY_CONFIG.credentials.clientId,
        client_secret: RELOADLY_CONFIG.credentials.clientSecret,
        grant_type: 'client_credentials',
        audience: getReloadlyAudience(api),
      }),
    })

    if (!res.ok) {
      const errorData = await res.json().catch(() => ({}))
      throw new ServiceUnavailableException(
        `Failed to authenticate with Reloadly: ${JSON.stringify(errorData)}`,
      )
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number }
    const token = data.access_token
    const expiresInSec = data.expires_in || RELOADLY_CONFIG.token.defaultExpiry
    // Store with a TTL slightly shorter than actual expiry (refresh buffer),
    // so a cached token is always still valid when read.
    const ttlMs = Math.max(1000, expiresInSec * 1000 - RELOADLY_CONFIG.token.refreshBuffer)
    await this.redis.setPx(this.tokenKey(api), token, ttlMs)
    return token
  }

  async clearToken(api: ReloadlyApi): Promise<void> {
    await this.redis.del(this.tokenKey(api))
  }

  /**
   * Fetch a Reloadly endpoint with the correct bearer token, retrying once on a
   * 401 with a forced token refresh. Auth/Content-Type headers are applied AFTER
   * the caller's headers so they can't be clobbered (matches the original).
   */
  async fetch(api: ReloadlyApi, url: string, options: RequestInit = {}): Promise<Response> {
    const token = await this.getToken(api)
    const headers = {
      ...(options.headers ?? {}),
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    }

    let response = await fetch(url, { ...options, headers })

    if (response.status === 401) {
      await this.clearToken(api)
      const fresh = await this.getToken(api, true)
      response = await fetch(url, {
        ...options,
        headers: {
          ...(options.headers ?? {}),
          Authorization: `Bearer ${fresh}`,
          'Content-Type': 'application/json',
        },
      })
    }

    return response
  }

  /** Convenience: fetch JSON, throwing on non-OK with a short body snippet. */
  async fetchJson<T>(api: ReloadlyApi, url: string, options: RequestInit = {}): Promise<T> {
    const res = await this.fetch(api, url, options)
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ServiceUnavailableException(
        `Reloadly ${api} request failed (${res.status}): ${body.slice(0, 300)}`,
      )
    }
    return (await res.json()) as T
  }

  /** Current prepaid topups balance (ports reloadly-balance.ts). */
  async getBalance(): Promise<{ balance: number; currencyCode: string }> {
    const res = await this.fetch('topups', `${getReloadlyUrl('topups')}/accounts/balance`, {
      headers: { Accept: 'application/com.reloadly.topups-v1+json' },
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new ServiceUnavailableException(`Reloadly balance failed (${res.status}): ${body.slice(0, 200)}`)
    }
    const data = (await res.json()) as { balance: number; currencyCode: string }
    return data
  }

  environment(): 'sandbox' | 'production' {
    return RELOADLY_CONFIG.isSandbox ? 'sandbox' : 'production'
  }
}
