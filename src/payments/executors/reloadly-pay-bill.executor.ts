import { Injectable } from '@nestjs/common'
import { ReloadlyService } from '../../providers/reloadly/reloadly.service'
import type { FulfillmentTransaction, UtilityFulfillmentOrder } from '../payments.types'

/**
 * Ported verbatim from TopupApp/src/lib/fulfillment/reloadly-pay-bill.ts
 * (executeReloadlyPayBill), as an injectable NestJS service using the shared
 * ReloadlyService for auth/fetch — same adaptation as ReloadlyTopupExecutor /
 * ReloadlyGiftCardExecutor.
 *
 * Addition beyond the frontend source (mirrors the other two executors): the fetch
 * call is wrapped so a rejected promise (timeout/connection reset/DNS failure — no
 * HTTP response ever received) is classified as `retryable: true`, since no
 * request-with-side-effects can have landed at Reloadly in that case.
 *
 * Also captures any provider-returned utility metadata into `transaction.meta` so
 * electricity billers that carry a token/units can have it persisted by the
 * orchestrator (same mechanism as the gift-card cardCode/cardPin). Reloadly's
 * synchronous /pay response is normally just a status/referenceId (the token, when
 * present, typically arrives via a later status poll) — this is a defensive capture
 * of `additionalInfo`/`meta`, not a field populated for most billers today.
 */
@Injectable()
export class ReloadlyPayBillExecutor {
  constructor(private readonly reloadly: ReloadlyService) {}

  async execute(order: UtilityFulfillmentOrder, paymentIntentId: string): Promise<FulfillmentTransaction> {
    if (!this.reloadly.hasCredentials()) {
      throw new Error('Reloadly API credentials not configured')
    }

    const apiUrl = this.reloadly.getUrl('utilities')
    const referenceId = order.referenceId || `pi_${paymentIntentId}`.substring(0, 36)

    const paymentPayload = {
      subscriberAccountNumber: order.accountNumber,
      amount: order.providerAmount,
      useLocalAmount: true,
      billerId: order.billerId,
      referenceId,
    }

    let paymentResponse: Awaited<ReturnType<ReloadlyService['fetch']>>
    try {
      paymentResponse = await this.reloadly.fetch('utilities', `${apiUrl}/pay`, {
        method: 'POST',
        headers: { Accept: 'application/com.reloadly.utilities-v1+json' },
        body: JSON.stringify(paymentPayload),
      })
    } catch (networkErr) {
      // The fetch promise itself rejected (timeout, connection reset, DNS failure, etc.)
      // — no HTTP response was ever received, so there's no status code to inspect. This
      // is always safe to retry: no request-with-side-effects can have landed at Reloadly.
      const err = new Error(
        networkErr instanceof Error ? networkErr.message : 'Network error calling Reloadly'
      ) as Error & { retryable?: boolean; statusCode?: number }
      err.retryable = true
      throw err
    }

    if (!paymentResponse.ok) {
      const errorData = await paymentResponse.json().catch(() => ({}))
      const err = new Error(errorData.message || 'Failed to process utility payment') as Error & {
        retryable?: boolean
        errorCode?: string
        statusCode?: number
      }
      err.retryable = paymentResponse.status >= 500
      err.errorCode = errorData.errorCode
      err.statusCode = paymentResponse.status
      throw err
    }

    const paymentResult = await paymentResponse.json()

    return {
      transactionId: String(paymentResult.id || paymentResult.transactionId),
      billerId: paymentResult.billerId ?? order.billerId,
      billerName: paymentResult.billerName ?? order.productName,
      accountNumber: paymentResult.subscriberAccountNumber ?? order.accountNumber,
      amount: paymentResult.amount ?? order.providerAmount,
      currency: paymentResult.deliveredAmountCurrencyCode ?? order.providerCurrency,
      status: paymentResult.status,
      referenceId: paymentResult.referenceId ?? referenceId,
      meta: paymentResult.additionalInfo ?? paymentResult.meta ?? null,
      timestamp: new Date().toISOString(),
      provider: 'reloadly',
    }
  }
}
