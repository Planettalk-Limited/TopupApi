// Server-side GA4 purchase reporting via the Measurement Protocol.
//
// WHY THE SERVER OWNS `purchase`: the browser cannot be trusted to report revenue.
// A payment that completes after a redirect (PayPal), a tab closed on the success
// screen, or an ad-blocker all silently drop a client-side purchase event. The order
// reaching PAID in our own database is the only reliable signal, so that is where the
// event is fired from. The client deliberately fires a non-revenue `checkout_completed`
// instead, so the funnel has no cliff but revenue is counted exactly once — here.
//
// Fire-and-forget, modelled on CustomerEmailService/AlertService: this NEVER throws and
// never blocks. Analytics must not be able to fail a payment.
import { Injectable, Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createHash } from 'crypto'

const MP_ENDPOINT = 'https://www.google-analytics.com/mp/collect'
// A hung GA endpoint must never hold up the fulfilment path.
const REQUEST_TIMEOUT_MS = 3_000

/** The three customer-facing journeys, kept identical to the client-side taxonomy. */
export type AnalyticsVertical = 'mobile_topup' | 'gift_card' | 'utility_bill'

export interface PurchaseEventParams {
  /** Stable and unique per order — GA4 dedupes purchases on this. */
  transactionId: string
  /** What the customer was actually charged (not the provider amount). */
  value: number
  currency: string
  /**
   * GA4 client id captured in the browser at checkout. The `_ga` cookie is set on the
   * registrable domain, so a single client id covers every GA4 property on the site.
   */
  clientId: string | null
  /** Per-property session ids keyed by measurement id — sessions are property-scoped. */
  sessions: Record<string, string> | null
  vertical: AnalyticsVertical
  countryCode: string
  provider: string
  productName?: string | null
}

type MpTarget = { name: string; measurementId: string; apiSecret: string }

@Injectable()
export class GaMeasurementProtocolService {
  private readonly logger = new Logger(GaMeasurementProtocolService.name)
  private readonly targets: MpTarget[]

  constructor(private readonly config: ConfigService) {
    // Two known properties: the standalone topup property, and the main marketing
    // property the topup app also dual-tags into so the cross-subdomain funnel has a
    // conversion at the end. A target is used only when BOTH its measurement id and its
    // api secret are present — api secrets are per data stream, never shared.
    const candidates = [
      { name: 'topup', idKey: 'GA_TOPUP_MEASUREMENT_ID', secretKey: 'GA_TOPUP_API_SECRET' },
      { name: 'marketing', idKey: 'GA_MARKETING_MEASUREMENT_ID', secretKey: 'GA_MARKETING_API_SECRET' },
    ]

    this.targets = candidates.flatMap(({ name, idKey, secretKey }) => {
      const measurementId = this.config.get<string>(idKey)
      const apiSecret = this.config.get<string>(secretKey)
      if (measurementId && apiSecret) return [{ name, measurementId, apiSecret }]
      if (measurementId || apiSecret) {
        this.logger.warn(`GA4 "${name}" target half-configured (needs both ${idKey} and ${secretKey}) — skipping`)
      }
      return []
    })

    if (this.targets.length === 0) {
      this.logger.warn('GA4 Measurement Protocol not configured — server-side purchase reporting disabled')
    } else {
      this.logger.log(`GA4 Measurement Protocol ready (${this.targets.map((t) => t.name).join(', ')})`)
    }
  }

  /**
   * Report a completed purchase to every configured GA4 property. Never throws: every
   * failure is logged and swallowed. Call this at most once per order — the caller owns
   * exactly-once semantics (see FulfillmentService's guarded CREATED -> PAID transition).
   */
  async sendPurchase(params: PurchaseEventParams): Promise<void> {
    try {
      if (this.targets.length === 0) return

      const clientId = params.clientId ?? this.syntheticClientId(params.transactionId)
      if (!params.clientId) {
        // Revenue completeness beats attribution purity: GA4 rejects a hit with no
        // client id outright, so we synthesise a stable one and accept that this order
        // lands as an unattributed direct user rather than vanishing from revenue.
        this.logger.warn(
          `No GA client id captured for order ${params.transactionId} — reporting purchase unattributed`,
        )
      }

      await Promise.allSettled(this.targets.map((target) => this.post(target, params, clientId)))
    } catch (err) {
      // Defensive: nothing above should throw, but this runs on the fulfilment path and
      // must be inert under all circumstances.
      this.logger.error('sendPurchase failed unexpectedly', err as Error)
    }
  }

  private async post(target: MpTarget, params: PurchaseEventParams, clientId: string): Promise<void> {
    const url =
      `${MP_ENDPOINT}?measurement_id=${encodeURIComponent(target.measurementId)}` +
      `&api_secret=${encodeURIComponent(target.apiSecret)}`

    const sessionId = params.sessions?.[target.measurementId]
    const eventParams: Record<string, unknown> = {
      transaction_id: params.transactionId,
      value: params.value,
      currency: params.currency,
      // Without a non-zero engagement time GA4 treats the hit as unengaged and it will
      // not attach to the originating session in reporting.
      engagement_time_msec: 1,
      vertical: params.vertical,
      country: params.countryCode,
      items: [
        {
          item_id: params.vertical,
          item_name: params.productName ?? params.vertical,
          item_category: params.vertical,
          item_brand: params.provider,
          price: params.value,
          quantity: 1,
        },
      ],
    }

    // Only send session_id when one was genuinely captured. A fabricated value would
    // splice this purchase into a session that never existed.
    if (sessionId) eventParams.session_id = sessionId

    const body = JSON.stringify({
      client_id: clientId,
      non_personalized_ads: true,
      events: [{ name: 'purchase', params: eventParams }],
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      })

      // MP answers 204 on accept and does NOT validate the payload — a 2xx means
      // "received", not "usable". Verify payload changes against GA4 DebugView or the
      // /debug/mp/collect endpoint, never against this status code alone.
      if (!res.ok) {
        const detail = await res.text().catch(() => '')
        this.logger.error(
          `GA4 (${target.name}) rejected purchase ${params.transactionId}: ${res.status} ${detail}`.trim(),
        )
      }
    } catch (err) {
      this.logger.error(`GA4 (${target.name}) purchase post failed for ${params.transactionId}`, err as Error)
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Deterministic stand-in shaped like a real GA client id (`<10 digits>.<10 digits>`),
   * derived from the order id so a retry reports as the same pseudo-user instead of
   * inflating user counts.
   */
  private syntheticClientId(transactionId: string): string {
    const digest = createHash('sha256').update(transactionId).digest('hex')
    const left = BigInt(`0x${digest.slice(0, 12)}`) % 10_000_000_000n
    const right = BigInt(`0x${digest.slice(12, 24)}`) % 10_000_000_000n
    return `${left.toString().padStart(10, '0')}.${right.toString().padStart(10, '0')}`
  }
}
