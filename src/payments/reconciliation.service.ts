// Fulfilment reconciliation worker — the safety net behind the webhook.
//
// The webhook (payments.controller.ts) is the primary fulfilment path, and Stripe
// redelivers on a 5xx so most transient failures self-heal within minutes without
// this worker ever doing anything. This worker exists for the cases redelivery
// doesn't cover:
//   - the webhook delivery itself never arrives (network/infra issue on Stripe's
//     or our side), leaving an order PAID with a PENDING/FAILED Fulfillment row
//     that nothing will ever re-touch;
//   - a claim has been in PROCESSING longer than a normal provider call should ever
//     take — either the process was killed mid-executor-call (crash) or the provider
//     call is simply slow. We cannot tell those two apart from here, and the executor
//     has no request timeout, so a "slow but still in flight" call is a real
//     possibility — see fulfillment.service.ts header for why that row is NOT safe to
//     re-execute automatically. We alert a human instead of touching it;
//   - a Fulfillment permanently fails (hits the attempts ceiling) and nobody is
//     watching the DB — ops should be paged, not left to notice via a support ticket.
//
// Every write here is either delegating to
// `FulfillmentService.fulfillByPaymentIntentId`, which already owns the
// claim/execute/record locking and provider-side dedup (customIdentifier) — this
// worker adds no new fulfilment logic of its own, it only decides *when* to call
// the existing, already-safe entrypoint — or an alert (no DB write at all). Never
// can it double-fulfil: recovery only re-claims PENDING/FAILED rows, PROCESSING rows
// are only ever read and alerted on, never reset or re-executed (a stale PROCESSING
// row might still be a real in-flight provider call; resetting it to FAILED and
// letting the FAILED-reclaim path re-run it would fire a second real provider call
// against the same top-up), and FULFILLED rows are left untouched. The claim itself
// is a `SELECT ... FOR UPDATE` inside a transaction shared with the webhook path, so
// a webhook that lands mid-run and this cron can never both execute.
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { FulfillmentStatus, OrderStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AlertService } from '../common/alert.service'
import { FulfillmentService, FulfillmentError } from './fulfillment.service'

// A PROCESSING claim older than this has been in flight longer than any normal
// provider call should take. That does NOT mean it's dead — the executor has no
// request timeout, so this can be a merely-slow-but-still-running call. We must
// never reset/re-execute it (see file header): doing so while the original call is
// still in flight would fire a second real provider call for the same top-up. So we
// only ever alert a human to go reconcile it against the provider's own transaction
// log; the row itself is left exactly as PROCESSING.
export const STALE_PROCESSING_MS = 5 * 60 * 1000 // 5 minutes

// How often this cron runs (Cron decorator below). Used to size the stale-PROCESSING
// alert window: we want to alert each stuck row ~once, as it crosses the
// STALE_PROCESSING_MS threshold, rather than re-alerting it every run until someone
// resolves it. Slightly wider than the actual 5-minute cadence so scheduling jitter
// can never let a crossing fall between two runs unnoticed.
export const RUN_WINDOW_MS = 6 * 60 * 1000 // 6 minutes

// Bounds how many stale-PROCESSING rows get alerted on per run, so a backlog can
// never turn this query/loop into unbounded work.
export const MAX_STALE_ALERTS_PER_RUN = 20

// Don't attempt recovery on an order more recently updated than this. The webhook
// is the primary path and is almost always faster than this cron's 5-minute
// cadence; without this delay the worker would routinely race a webhook that's
// still mid-flight and burn an attempt for no reason.
export const RETRY_DELAY_MS = 3 * 60 * 1000 // 3 minutes

// Matches the orchestrator's retry ceiling. Once a Fulfillment has failed this many
// times we stop auto-retrying it (further attempts are almost certainly a
// permanent/non-retryable condition) and alert instead.
export const MAX_ATTEMPTS = 5

// Bounds the work done per run so a backlog can never turn this cron into an
// unbounded or overlapping job.
export const MAX_RECOVERIES_PER_RUN = 20

// Alert window for permanent failures. Wider than the 5-minute cron interval so a
// crossing is never missed to scheduling jitter, but short enough that — since a
// Fulfillment stuck at >= MAX_ATTEMPTS is no longer retried and so stops having its
// `updatedAt` touched — we naturally alert once per failure and then fall silent,
// with no in-memory state to maintain (safe across restarts/replicas).
export const ALERT_WINDOW_MS = 6 * 60 * 1000 // 6 minutes

@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly fulfillment: FulfillmentService,
    private readonly alert: AlertService
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async reconcile(): Promise<void> {
    const now = new Date()

    const staleAlerted = await this.reclaimStaleProcessing(now)
    const { attempted, recovered } = await this.recoverUnfulfilledPaidOrders(now)
    const alerted = await this.alertPermanentFailures(now)

    this.logger.log(
      `Reconciliation run complete: staleProcessingAlerted=${staleAlerted} recoveryAttempted=${attempted} recovered=${recovered} alertsSent=${alerted}`
    )
  }

  /**
   * §1 Stale PROCESSING: a claim that has been in flight longer than STALE_PROCESSING_MS.
   * NEVER reset/re-execute (see file header) — we only read these rows and alert a
   * human to reconcile against the provider's own transaction log. The row's status
   * is never written here.
   *
   * Dedup: without a window, the same stuck row would be re-alerted on every 5-minute
   * run for as long as it stays stuck. So we only alert rows whose `processingClaimedAt`
   * falls in the band [now - STALE_PROCESSING_MS - RUN_WINDOW_MS, now - STALE_PROCESSING_MS)
   * — i.e. rows that *just* crossed the staleness threshold within roughly the last run
   * window. A row stuck for hours crossed that threshold long ago and falls outside the
   * band, so it naturally stops being re-alerted after its first crossing.
   */
  private async reclaimStaleProcessing(now: Date): Promise<number> {
    let alerted = 0
    try {
      const staleCutoff = new Date(now.getTime() - STALE_PROCESSING_MS)
      const windowStart = new Date(now.getTime() - STALE_PROCESSING_MS - RUN_WINDOW_MS)
      const stale = await this.prisma.fulfillment.findMany({
        where: {
          status: FulfillmentStatus.PROCESSING,
          processingClaimedAt: { gte: windowStart, lt: staleCutoff },
        },
        include: { order: { select: { id: true, paymentIntentId: true } } },
        take: MAX_STALE_ALERTS_PER_RUN,
      })

      for (const f of stale) {
        const stuckForMs = f.processingClaimedAt ? now.getTime() - f.processingClaimedAt.getTime() : undefined
        const stuckForMin = stuckForMs !== undefined ? Math.round(stuckForMs / 60000) : 'unknown'
        try {
          await this.alert.notify(
            `Fulfillment stuck in PROCESSING for ~${stuckForMin} min — order ${f.order?.id ?? f.orderId}, paymentIntent ${f.order?.paymentIntentId ?? 'unknown'}. NOT auto-reset (may still be in flight); reconcile manually against the provider's transaction log.`,
            'warning'
          )
          alerted++
        } catch (err) {
          // AlertService.notify is documented to never throw, but guard anyway —
          // one alert failing to send must never stop the others or abort the run.
          this.logger.error(`Failed to send stale-PROCESSING alert for order ${f.orderId}`, err as Error)
        }
      }
      if (alerted > 0) {
        this.logger.warn(`Alerted on ${alerted} stale PROCESSING fulfillment(s)`)
      }
      return alerted
    } catch (err) {
      this.logger.error('Failed to query stale PROCESSING fulfillments for alerting', err as Error)
      return alerted
    }
  }

  /**
   * §2 Recover unfulfilled PAID orders whose webhook apparently never landed (or
   * landed and failed retryably and was never redelivered). Delegates to
   * `fulfillByPaymentIntentId`, which is idempotent/dedup-safe by construction —
   * see file header. Capped per run; each order is isolated in its own try/catch
   * so one bad order can't abort the rest.
   */
  private async recoverUnfulfilledPaidOrders(now: Date): Promise<{ attempted: number; recovered: number }> {
    let attempted = 0
    let recovered = 0
    try {
      const cutoff = new Date(now.getTime() - RETRY_DELAY_MS)
      const orders = await this.prisma.order.findMany({
        where: {
          status: OrderStatus.PAID,
          updatedAt: { lt: cutoff },
          fulfillment: {
            status: { in: [FulfillmentStatus.PENDING, FulfillmentStatus.FAILED] },
            attempts: { lt: MAX_ATTEMPTS },
          },
        },
        select: { id: true, paymentIntentId: true },
        take: MAX_RECOVERIES_PER_RUN,
      })

      for (const order of orders) {
        attempted++
        try {
          const outcome = await this.fulfillment.fulfillByPaymentIntentId(order.paymentIntentId)
          this.logger.log(`Reconciliation recovery for order ${order.id}: ${outcome.status}`)
          if (outcome.status === 'fulfilled') recovered++
        } catch (err) {
          const message =
            err instanceof FulfillmentError ? err.message : String((err as Error)?.message ?? err)
          this.logger.warn(`Reconciliation recovery failed for order ${order.id}: ${message}`)
        }
      }
    } catch (err) {
      this.logger.error('Failed to query/recover unfulfilled PAID orders', err as Error)
    }
    return { attempted, recovered }
  }

  /**
   * §3 Alert on permanent failures (attempts >= MAX_ATTEMPTS). Windowed on
   * `updatedAt` rather than an in-memory "already alerted" set: once a Fulfillment
   * hits the ceiling, §2's `attempts < MAX_ATTEMPTS` filter excludes it from any
   * further retry, so nothing touches its `updatedAt` again — it falls out of the
   * window on its own after ~ALERT_WINDOW_MS and is never re-alerted, with no
   * per-process state to lose on restart or diverge across replicas.
   */
  private async alertPermanentFailures(now: Date): Promise<number> {
    let alerted = 0
    try {
      const cutoff = new Date(now.getTime() - ALERT_WINDOW_MS)
      const failures = await this.prisma.fulfillment.findMany({
        where: {
          status: FulfillmentStatus.FAILED,
          attempts: { gte: MAX_ATTEMPTS },
          updatedAt: { gte: cutoff },
        },
        include: { order: { select: { id: true, paymentIntentId: true } } },
      })

      for (const f of failures) {
        try {
          await this.alert.notify(
            `Fulfillment permanently failed after ${f.attempts} attempts — order ${f.order?.id ?? f.orderId}, paymentIntent ${f.order?.paymentIntentId ?? 'unknown'}: ${f.lastError ?? 'unknown error'}`,
            'critical'
          )
          alerted++
        } catch (err) {
          // AlertService.notify is documented to never throw, but guard anyway —
          // one alert failing to send must never stop the others or abort the run.
          this.logger.error(`Failed to send alert for permanently-failed order ${f.orderId}`, err as Error)
        }
      }
    } catch (err) {
      this.logger.error('Failed to query permanently-failed fulfillments for alerting', err as Error)
    }
    return alerted
  }
}
