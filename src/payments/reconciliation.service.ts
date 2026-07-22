// Fulfilment reconciliation worker — the safety net behind the webhook.
//
// The webhook (payments.controller.ts) is the primary fulfilment path, and Stripe
// redelivers on a 5xx so most transient failures self-heal within minutes without
// this worker ever doing anything. This worker exists for the cases redelivery
// doesn't cover:
//   - the webhook delivery itself never arrives (network/infra issue on Stripe's
//     or our side), leaving an order PAID with a PENDING/FAILED Fulfillment row
//     that nothing will ever re-touch;
//   - a claim gets stuck in PROCESSING forever (process killed mid-executor-call,
//     before Phase 3 could record success or failure) — see fulfillment.service.ts
//     header for why that row is NOT safe to just re-run automatically as PENDING;
//   - a Fulfillment permanently fails (hits the attempts ceiling) and nobody is
//     watching the DB — ops should be paged, not left to notice via a support ticket.
//
// Every write here is either a bulk `updateMany` (§1) or delegates to
// `FulfillmentService.fulfillByPaymentIntentId`, which already owns the
// claim/execute/record locking and provider-side dedup (customIdentifier) — this
// worker adds no new fulfilment logic of its own, it only decides *when* to call
// the existing, already-safe entrypoint. Never can it double-fulfil: recovery only
// re-claims PENDING/FAILED rows (PROCESSING/FULFILLED are left untouched), and the
// claim is a `SELECT ... FOR UPDATE` inside a transaction shared with the webhook
// path, so a webhook that lands mid-run and this cron can never both execute.
import { Injectable, Logger } from '@nestjs/common'
import { Cron, CronExpression } from '@nestjs/schedule'
import { FulfillmentStatus, OrderStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AlertService } from '../common/alert.service'
import { FulfillmentService, FulfillmentError } from './fulfillment.service'

// A PROCESSING claim older than this never completed (crash mid-executor-call, or
// the process was killed before Phase 3 could write FULFILLED/FAILED). Reset it to
// FAILED so the orchestrator's FAILED-reclaim path (fulfillment.service.ts Phase 1)
// can pick it back up on the next recovery pass — never resurrected as PENDING,
// which would skip the attempts-tracking a FAILED row carries.
export const STALE_PROCESSING_MS = 5 * 60 * 1000 // 5 minutes

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

    const staleReclaimed = await this.reclaimStaleProcessing(now)
    const { attempted, recovered } = await this.recoverUnfulfilledPaidOrders(now)
    const alerted = await this.alertPermanentFailures(now)

    this.logger.log(
      `Reconciliation run complete: staleProcessingReclaimed=${staleReclaimed} recoveryAttempted=${attempted} recovered=${recovered} alertsSent=${alerted}`
    )
  }

  /**
   * §1 Stale PROCESSING: a claim that never completed. Bulk `updateMany` — cheap,
   * and there is nothing per-row to branch on, so no try/catch-per-row is needed
   * (the whole section is still guarded so a DB blip here can't abort the run).
   */
  private async reclaimStaleProcessing(now: Date): Promise<number> {
    try {
      const cutoff = new Date(now.getTime() - STALE_PROCESSING_MS)
      const result = await this.prisma.fulfillment.updateMany({
        where: { status: FulfillmentStatus.PROCESSING, processingClaimedAt: { lt: cutoff } },
        data: { status: FulfillmentStatus.FAILED, lastError: 'stale processing lock reclaimed by reconciliation' },
      })
      if (result.count > 0) {
        this.logger.warn(`Reclaimed ${result.count} stale PROCESSING fulfillment(s)`)
      }
      return result.count
    } catch (err) {
      this.logger.error('Failed to reclaim stale PROCESSING fulfillments', err as Error)
      return 0
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
