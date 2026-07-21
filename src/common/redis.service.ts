import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import Redis from 'ioredis'

/**
 * Shared Redis client. Backs the provider OAuth token caches (so replicas don't
 * each re-auth against Reloadly/buhibab) and the rate-limit store. Wraps the raw
 * client with small get/set/del helpers; callers that need the client directly
 * (e.g. the throttler storage) can use `client`.
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisService.name)
  readonly client: Redis

  constructor(config: ConfigService) {
    const url = config.get<string>('REDIS_URL') ?? 'redis://localhost:6379'
    this.client = new Redis(url, {
      // Don't crash the app if Redis is briefly unavailable; commands queue then
      // fail fast, and callers treat cache misses/errors as "no cached value".
      maxRetriesPerRequest: 2,
      lazyConnect: false,
      retryStrategy: (times) => Math.min(times * 200, 2000),
    })
    this.client.on('error', (err) => this.logger.error(`Redis error: ${err.message}`))
  }

  async get(key: string): Promise<string | null> {
    try {
      return await this.client.get(key)
    } catch (err) {
      this.logger.warn(`Redis GET ${key} failed: ${(err as Error).message}`)
      return null
    }
  }

  /** Set with a TTL in milliseconds. Swallows errors (best-effort cache). */
  async setPx(key: string, value: string, ttlMs: number): Promise<void> {
    try {
      await this.client.set(key, value, 'PX', Math.max(1, Math.floor(ttlMs)))
    } catch (err) {
      this.logger.warn(`Redis SET ${key} failed: ${(err as Error).message}`)
    }
  }

  async del(key: string): Promise<void> {
    try {
      await this.client.del(key)
    } catch (err) {
      this.logger.warn(`Redis DEL ${key} failed: ${(err as Error).message}`)
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit().catch(() => undefined)
  }
}
