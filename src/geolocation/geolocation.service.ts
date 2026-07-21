import { Injectable, Logger } from '@nestjs/common'
import { RedisService } from '../common/redis.service'

export interface GeoResult {
  success: boolean
  country: string
  countryName: string | null
  city: string | null
  region: string | null
  currency: string | null
  ip: string
  timezone: string | null
  source: string
  fallback?: boolean
  error?: string
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000 // 24h — geo of an IP rarely changes

const UK_DEFAULT = (ip: string, extra?: Partial<GeoResult>): GeoResult => ({
  success: false,
  country: 'GB',
  countryName: 'United Kingdom',
  city: null,
  region: null,
  currency: 'GBP',
  ip,
  timezone: null,
  fallback: true,
  source: 'default',
  ...extra,
})

/**
 * IP geolocation. Ports TopupApp's /api/geolocation fallback chain
 * (ipapi.co → ip-api.com → GB default) and adds a Redis cache keyed by IP,
 * which the original lacked (it hit the providers on every request).
 */
@Injectable()
export class GeolocationService {
  private readonly logger = new Logger(GeolocationService.name)

  constructor(private readonly redis: RedisService) {}

  resolveClientIp(forwarded?: string, realIp?: string): string {
    let ip = forwarded?.split(',')[0]?.trim() || realIp || 'unknown'
    const isLocal =
      ip === 'unknown' ||
      ip === '::1' ||
      ip === '127.0.0.1' ||
      ip.includes('::ffff:127.0.0.1') ||
      ip.startsWith('192.168.') ||
      ip.startsWith('10.') ||
      ip.startsWith('172.')
    if (isLocal) ip = '41.57.0.1' // public test IP so local dev gets a real result
    return ip
  }

  async lookup(ip: string): Promise<GeoResult> {
    const cacheKey = `geo:${ip}`
    const cached = await this.redis.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached) as GeoResult
      } catch {
        // ignore malformed cache
      }
    }

    const result = await this.doLookup(ip)
    // Only cache confident results, not the GB fallback.
    if (result.success) {
      await this.redis.setPx(cacheKey, JSON.stringify(result), CACHE_TTL_MS)
    }
    return result
  }

  private async doLookup(ip: string): Promise<GeoResult> {
    // Primary: ipapi.co
    try {
      const res = await fetch(`https://ipapi.co/${ip}/json/`, {
        headers: { 'User-Agent': 'PlanetTalk-TopUp/1.0' },
      })
      if (res.ok) {
        const g = (await res.json()) as Record<string, string>
        const country = g.country_code || g.country
        if (country && country !== 'undefined') {
          return {
            success: true,
            country,
            countryName: g.country_name ?? null,
            city: g.city ?? null,
            region: g.region ?? null,
            currency: g.currency ?? null,
            ip: g.ip ?? ip,
            timezone: g.timezone ?? null,
            source: 'ipapi.co',
          }
        }
      }
    } catch {
      // fall through
    }

    // Fallback: ip-api.com
    try {
      const res = await fetch(
        `http://ip-api.com/json/${ip}?fields=status,country,countryCode,city,regionName,timezone,currency`,
      )
      if (res.ok) {
        const d = (await res.json()) as Record<string, string>
        if (d.status === 'success') {
          return {
            success: true,
            country: d.countryCode,
            countryName: d.country ?? null,
            city: d.city ?? null,
            region: d.regionName ?? null,
            currency: d.currency ?? null,
            ip,
            timezone: d.timezone ?? null,
            source: 'ip-api.com',
          }
        }
      }
    } catch {
      // fall through
    }

    return UK_DEFAULT(ip)
  }
}
