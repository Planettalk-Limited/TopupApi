import { Injectable, Logger } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service'

export interface RatesSnapshot {
  rates: Record<string, number>
  timestamp: number
}

const CACHE_DURATION = 60 * 60 * 1000 // 1 hour

/**
 * Display-only FX rates (GBP base). Ports TopupApp's currency-rates.ts, but the
 * 1-hour cache is persisted in the FxRateCache table (survives restarts, shared
 * across replicas) instead of module-level memory.
 *
 * IMPORTANT: this is NOT the source of charged prices. Pricing uses a separate
 * static table (ported verbatim in Phase 4). Keep the two apart.
 */
@Injectable()
export class CurrencyService {
  private readonly logger = new Logger(CurrencyService.name)

  constructor(private readonly prisma: PrismaService) {}

  async getRatesGBP(): Promise<RatesSnapshot> {
    // Serve from the DB cache if a recent snapshot exists.
    try {
      const latest = await this.prisma.fxRateCache.findFirst({ orderBy: { fetchedAt: 'desc' } })
      if (latest && Date.now() - latest.fetchedAt.getTime() < CACHE_DURATION) {
        return { rates: latest.rates as Record<string, number>, timestamp: latest.fetchedAt.getTime() }
      }
    } catch (err) {
      this.logger.warn(`FX cache read failed, fetching fresh: ${(err as Error).message}`)
    }

    const merged = await this.fetchFromProviders()
    const now = Date.now()

    // Best-effort persist: keep a single logical snapshot.
    try {
      await this.prisma.$transaction([
        this.prisma.fxRateCache.deleteMany({}),
        this.prisma.fxRateCache.create({ data: { base: 'GBP', rates: merged } }),
      ])
    } catch (err) {
      this.logger.warn(`FX cache write failed (serving fresh anyway): ${(err as Error).message}`)
    }

    return { rates: merged, timestamp: now }
  }

  private async fetchFromProviders(): Promise<Record<string, number>> {
    const frankfurter = await fetch('https://api.frankfurter.app/latest?from=GBP')
    if (!frankfurter.ok) throw new Error('Frankfurter API failed')
    const frankfurterData = (await frankfurter.json()) as { rates: Record<string, number> }

    try {
      const erapi = await fetch('https://open.er-api.com/v6/latest/GBP')
      if (erapi.ok) {
        const erapiData = (await erapi.json()) as { rates: Record<string, number> }
        return { ...erapiData.rates, ...frankfurterData.rates, GBP: 1 }
      }
    } catch {
      // fall through to Frankfurter-only
    }
    return { ...frankfurterData.rates, GBP: 1 }
  }

  convertWithRates(amount: number, from: string, to: string, rates: Record<string, number>): number {
    const fromKey = from.toUpperCase()
    const toKey = to.toUpperCase()
    if (fromKey === toKey) return amount
    const fromRate = rates[fromKey]
    const toRate = rates[toKey]
    if (!fromRate) throw new Error(`Currency rate not found: ${fromKey}`)
    if (!toRate) throw new Error(`Currency rate not found: ${toKey}`)
    return amount * (toRate / fromRate)
  }
}
