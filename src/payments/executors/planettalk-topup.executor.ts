import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from '../../providers/buhibab/planettalk.service'
import { getPlanetTalkUrl } from '../../providers/buhibab/planettalk.config'
import { resolveProductId } from '../../providers/buhibab/planettalk.mappers'
import type { FulfillmentTransaction, TopupFulfillmentOrder } from '../payments.types'

// PlanetTalk field names that act as a client-supplied idempotency/reference key. If the resolved
// product exposes one of these we pass `pi_<intentId>`, giving provider-side dedup against a
// double submission (e.g. webhook + client fallback both firing).
const REFERENCE_FIELD_NAMES = ['reference', 'requestId', 'request_id', 'merchantReference']

/**
 * Ported verbatim from TopupApp/src/lib/fulfillment/planettalk-topup.ts
 * (executePlanetTalkTopup), as an injectable NestJS service using the shared
 * PlanetTalkService for auth/fetch + operator/product resolution instead of the
 * frontend's `planetTalkFetch`/`fetchAndBuildOperators`.
 *
 * buhibab has NO sandbox — this executor is unit-tested with a mocked
 * PlanetTalkService.fetch only; it must never be exercised against the live API
 * outside a real purchase flow.
 */
@Injectable()
export class PlanetTalkTopupExecutor {
  constructor(private readonly planetTalk: PlanetTalkService) {}

  async execute(order: TopupFulfillmentOrder, paymentIntentId: string): Promise<FulfillmentTransaction> {
    if (!this.planetTalk.hasCredentials()) {
      throw new Error('Planet Talk API credentials not configured')
    }

    if (order.countryCode.toUpperCase() !== 'NG') {
      throw new Error('Planet Talk topup is only available for Nigeria (NG)')
    }

    const localAmount = order.providerAmount
    const { productMap } = await this.planetTalk.fetchAndBuildOperators()
    const mapping = resolveProductId(productMap, order.operatorId, localAmount)

    if (!mapping) {
      const err = new Error('No matching Planet Talk product found for this operator and amount') as Error & {
        retryable?: boolean
      }
      err.retryable = false
      throw err
    }

    let phone =
      typeof order.recipientPhone === 'string'
        ? order.recipientPhone.replace(/[\s\-\(\)\+]/g, '')
        : String(order.recipientPhone)

    if (phone.startsWith('234') && phone.length > 11) {
      phone = '0' + phone.slice(3)
    }
    if (phone.length === 10 && /^[789]/.test(phone)) {
      phone = '0' + phone
    }

    const formData = new FormData()
    const fieldNames = mapping.additionalFields.map((f) => f.name)

    if (fieldNames.includes('phone')) formData.append('phone', phone)
    if (fieldNames.includes('recipient')) formData.append('recipient', phone)
    if (fieldNames.includes('billersCode')) formData.append('billersCode', phone)

    if (!mapping.fixedPrice) {
      formData.append('amount', String(localAmount))
    }

    // buhibab now requires `email` on every purchase (it also sends its own
    // confirmation email). Send it whenever we have it.
    if (order.email) {
      formData.append('email', order.email)
    }

    if (paymentIntentId) {
      const refField = fieldNames.find((name) => REFERENCE_FIELD_NAMES.includes(name))
      if (refField) formData.append(refField, `pi_${paymentIntentId}`)
    }

    const apiUrl = `${getPlanetTalkUrl()}/products/${mapping.productId}/purchase`

    let purchaseRes: Response
    try {
      purchaseRes = await this.planetTalk.fetch(apiUrl, {
        method: 'POST',
        body: formData,
      })
    } catch (networkErr) {
      // The fetch promise itself rejected (timeout, connection reset, DNS failure, etc.)
      // — no HTTP response was ever received, so there's no status code to inspect. This
      // is always safe to retry: no request-with-side-effects can have landed at buhibab.
      const err = new Error(
        networkErr instanceof Error ? networkErr.message : 'Network error calling Planet Talk'
      ) as Error & { retryable?: boolean; statusCode?: number }
      err.retryable = true
      throw err
    }

    const responseBody = await purchaseRes.json().catch(() => ({}))

    if (!purchaseRes.ok) {
      const err = new Error(responseBody.message || 'Failed to process top-up') as Error & {
        retryable?: boolean
        statusCode?: number
      }
      err.retryable = purchaseRes.status >= 500
      err.statusCode = purchaseRes.status
      throw err
    }

    return {
      transactionId: String(
        responseBody.data?.transaction_id ?? responseBody.data?.id ?? Date.now()
      ),
      operatorTransactionId: null,
      status: responseBody.data?.status ?? 'SUCCESSFUL',
      deliveryStatus: 'DELIVERED',
      amount: localAmount,
      currency: 'NGN',
      recipientPhone: phone,
      productName: mapping.productName,
      // Airtime/Data return null meta; captured generically for parity with utilities.
      meta: responseBody.data?.meta ?? responseBody.meta ?? null,
      timestamp: new Date().toISOString(),
      provider: 'planettalk',
    }
  }
}
