// Synthetic monitoring: "we hear about breakage before customers do".
//
// Every few minutes this replays the reads a customer's browser makes to render each
// product page (see synthetic-checks.ts) plus a plain GET of each public page, and emails
// ops (AlertService → OPS_ALERT_EMAILS + the alert webhook) when something stops working.
// It exists because a broken product page was previously only noticed when the client
// stumbled on it after customers had already hit it.
//
// Alerting is on TRANSITIONS only (check-state.ts): one email when a check has failed
// SYNTHETIC_FAILURE_THRESHOLD runs in a row, one when it passes again. All checks that
// change in the same run are folded into a single email, so a full outage (API down →
// every check fails at once) is one message, not fifteen.
//
// State lives in memory, deliberately:
//   - it's tiny and only meaningful while the process runs, so a table + migration buys
//     little;
//   - the cost of losing it on restart is bounded: a check that is still broken after a
//     deploy alerts again after `threshold` runs (one duplicate email), and a check that
//     recovered *during* the restart gets no "recovered" email — acceptable for a
//     single-container deployment (docker-compose.yml runs one `app` replica);
//   - if this ever runs as several replicas, each would alert independently — move the
//     state to Redis (RedisService is already global) at that point.
//
// The interval is env-configurable, which a static @Cron() expression can't be, so the job
// is registered through SchedulerRegistry (still @nestjs/schedule, like
// reconciliation.service.ts, so it's visible/stoppable the same way).
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SchedulerRegistry } from '@nestjs/schedule'
import { AlertService } from '../common/alert.service'
import { isHealthcareEnabled } from '../common/healthcare-enabled'
import { isVouchersEnabled } from '../common/vouchers-enabled'
import { applyOutcome, CheckOutcome, CheckState, initialCheckState } from './check-state'
import { createProbe, Probe } from './http-probe'
import { buildSyntheticChecks, SyntheticCheck, SyntheticCheckConfig } from './synthetic-checks'

export const SYNTHETIC_INTERVAL_NAME = 'synthetic-monitor'

export const DEFAULTS = {
  intervalMinutes: 5,
  failureThreshold: 2,
  timeoutMs: 15_000,
  siteUrl: 'https://planettalk.com',
  // planettalk.com serves the app; these must keep resolving (www → apex, mobiletopup →
  // path-preserving redirect during the cutover — see CORS_ORIGIN in .env.example).
  siteAliases: 'https://www.planettalk.com,https://mobiletopup.planettalk.com',
  topupCountry: 'GH',
  giftCardCountry: 'US',
  healthcareQuery: 'paracetamol',
} as const

export type CheckStatus = 'pending' | 'ok' | 'failing' | 'down'

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : fallback
}

function trimSlash(url: string): string {
  return url.trim().replace(/\/+$/, '')
}

@Injectable()
export class SyntheticMonitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SyntheticMonitorService.name)

  readonly enabled: boolean
  readonly intervalMinutes: number
  readonly failureThreshold: number
  readonly checks: SyntheticCheck[]
  private readonly probe: Probe
  private readonly states = new Map<string, CheckState>()
  private running = false
  private lastRunStartedAt: Date | null = null
  private lastRunFinishedAt: Date | null = null

  constructor(
    private readonly config: ConfigService,
    private readonly alerts: AlertService,
    private readonly scheduler: SchedulerRegistry,
  ) {
    // On by default in production only: a local or staging backend probing itself would
    // email the real ops list about its own half-configured state.
    const flag = this.config.get<string>('SYNTHETIC_MONITORING_ENABLED')
    this.enabled = flag ? flag === 'true' : this.config.get<string>('NODE_ENV') === 'production'
    this.intervalMinutes = positiveInt(this.config.get('SYNTHETIC_INTERVAL_MINUTES'), DEFAULTS.intervalMinutes)
    this.failureThreshold = positiveInt(this.config.get('SYNTHETIC_FAILURE_THRESHOLD'), DEFAULTS.failureThreshold)
    this.probe = createProbe(positiveInt(this.config.get('SYNTHETIC_TIMEOUT_MS'), DEFAULTS.timeoutMs))
    this.checks = buildSyntheticChecks(this.readCheckConfig())
    for (const check of this.checks) this.states.set(check.id, initialCheckState())
  }

  private readCheckConfig(): SyntheticCheckConfig {
    const port = this.config.get<string>('PORT') ?? '3000'
    // Default to the API on this same container: works with no extra config and doesn't
    // depend on DNS/Traefik. Point it at the public URL to also cover the proxy and TLS.
    const apiBaseUrl = trimSlash(this.config.get<string>('SYNTHETIC_API_BASE_URL') || `http://127.0.0.1:${port}/api`)
    // `??` not `||`: an explicitly empty SYNTHETIC_SITE_URL turns the page checks off.
    const siteBaseUrl = trimSlash(this.config.get<string>('SYNTHETIC_SITE_URL') ?? DEFAULTS.siteUrl)
    const siteAliasUrls = (this.config.get<string>('SYNTHETIC_SITE_ALIASES') ?? DEFAULTS.siteAliases)
      .split(',')
      .map(trimSlash)
      .filter(Boolean)
    return {
      apiBaseUrl,
      siteBaseUrl,
      siteAliasUrls: siteBaseUrl ? siteAliasUrls : [],
      ngProvider: this.config.get<string>('TOPUP_PROVIDER_NG') === 'planettalk' ? 'planettalk' : 'reloadly',
      topupCountry: (this.config.get<string>('SYNTHETIC_TOPUP_COUNTRY') || DEFAULTS.topupCountry).toUpperCase(),
      giftCardCountry: (this.config.get<string>('SYNTHETIC_GIFT_CARD_COUNTRY') || DEFAULTS.giftCardCountry).toUpperCase(),
      vouchersEnabled: isVouchersEnabled(),
      healthcareEnabled: isHealthcareEnabled(),
      healthcareQuery: this.config.get<string>('SYNTHETIC_HEALTHCARE_QUERY') || DEFAULTS.healthcareQuery,
    }
  }

  onModuleInit() {
    if (!this.enabled) {
      this.logger.log('Synthetic monitoring disabled (set SYNTHETIC_MONITORING_ENABLED=true to enable)')
      return
    }
    const handle = setInterval(() => void this.runOnce(), this.intervalMinutes * 60_000)
    this.scheduler.addInterval(SYNTHETIC_INTERVAL_NAME, handle)
    this.logger.log(
      `Synthetic monitoring: ${this.checks.length} checks every ${this.intervalMinutes} min, ` +
        `alert after ${this.failureThreshold} consecutive failures`,
    )
  }

  onModuleDestroy() {
    if (this.scheduler.doesExist('interval', SYNTHETIC_INTERVAL_NAME)) {
      this.scheduler.deleteInterval(SYNTHETIC_INTERVAL_NAME)
    }
  }

  /** One pass over every check, then at most one DOWN email and one RECOVERED email. Never throws. */
  async runOnce(): Promise<void> {
    // A slow run (several timeouts) must not overlap the next tick and double-count failures.
    if (this.running) {
      this.logger.warn('Previous synthetic run still in progress — skipping this tick')
      return
    }
    this.running = true
    this.lastRunStartedAt = new Date()
    try {
      const api = this.checks.filter((c) => c.kind === 'api')
      const site = this.checks.filter((c) => c.kind === 'site')
      // API checks run one at a time: buhibab allows one login token per account, and
      // several first-calls racing to log in would cancel each other's tokens. Page checks
      // only touch the Next.js site, so they run in parallel alongside.
      const results = await Promise.all([
        (async () => {
          const out: Array<readonly [SyntheticCheck, CheckOutcome]> = []
          for (const check of api) out.push([check, await this.execute(check)])
          return out
        })(),
        Promise.all(site.map(async (check) => [check, await this.execute(check)] as const)),
      ])

      const down: SyntheticCheck[] = []
      const recovered: Array<{ check: SyntheticCheck; since: Date | null }> = []
      for (const [check, outcome] of [...results[0], ...results[1]]) {
        const prev = this.states.get(check.id) ?? initialCheckState()
        const { state, transition } = applyOutcome(prev, outcome, this.failureThreshold)
        this.states.set(check.id, state)
        if (!outcome.ok) this.logger.warn(`Synthetic check ${check.id} failed: ${outcome.error}`)
        if (transition === 'down') down.push(check)
        if (transition === 'recovered') recovered.push({ check, since: prev.failingSince })
      }

      if (down.length > 0) await this.alerts.notify(this.downMessage(down), 'critical')
      if (recovered.length > 0) await this.alerts.notify(this.recoveredMessage(recovered), 'info')
    } catch (err) {
      this.logger.error('Synthetic monitor run failed', err as Error)
    } finally {
      this.running = false
      this.lastRunFinishedAt = new Date()
    }
  }

  private async execute(check: SyntheticCheck): Promise<CheckOutcome> {
    const started = Date.now()
    try {
      await check.run(this.probe)
      return { ok: true, latencyMs: Date.now() - started, at: new Date() }
    } catch (err) {
      return { ok: false, error: (err as Error).message, latencyMs: Date.now() - started, at: new Date() }
    }
  }

  private downMessage(down: SyntheticCheck[]): string {
    const lines = down.map((c) => {
      const s = this.states.get(c.id)!
      return (
        `- ${c.label}\n  ${c.target}\n  Error: ${s.lastError}\n` +
        `  Failing since ${s.failingSince?.toISOString()} (${s.consecutiveFailures} checks in a row)`
      )
    })
    return (
      `TopUp monitor: ${down.length === 1 ? 'a check is' : `${down.length} checks are`} FAILING — ` +
      `customers are probably affected.\n\n${lines.join('\n\n')}\n\n` +
      `You'll get one more message when it recovers. Live status: GET /api/admin/monitoring/status`
    )
  }

  private recoveredMessage(recovered: Array<{ check: SyntheticCheck; since: Date | null }>): string {
    const now = Date.now()
    const lines = recovered.map(({ check, since }) => {
      const mins = since ? Math.round((now - since.getTime()) / 60_000) : null
      return `- ${check.label}${mins !== null ? ` (was failing for ~${mins} min)` : ''}`
    })
    return `TopUp monitor: RECOVERED — working again:\n\n${lines.join('\n')}`
  }

  /** Snapshot for the admin status endpoint. */
  status() {
    const checks = this.checks.map((check) => {
      const s = this.states.get(check.id) ?? initialCheckState()
      const status: CheckStatus =
        s.lastOk === null ? 'pending' : s.alerting ? 'down' : s.lastOk ? 'ok' : 'failing'
      return { id: check.id, label: check.label, kind: check.kind, target: check.target, status, ...s }
    })
    return {
      enabled: this.enabled,
      intervalMinutes: this.intervalMinutes,
      failureThreshold: this.failureThreshold,
      running: this.running,
      lastRunStartedAt: this.lastRunStartedAt,
      lastRunFinishedAt: this.lastRunFinishedAt,
      summary: {
        total: checks.length,
        ok: checks.filter((c) => c.status === 'ok').length,
        failing: checks.filter((c) => c.status === 'failing').length,
        down: checks.filter((c) => c.status === 'down').length,
        pending: checks.filter((c) => c.status === 'pending').length,
      },
      checks,
    }
  }
}
