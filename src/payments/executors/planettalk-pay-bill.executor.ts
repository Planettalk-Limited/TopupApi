import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from '../../providers/buhibab/planettalk.service'
import { getPlanetTalkUrl } from '../../providers/buhibab/planettalk.config'
import type { FulfillmentTransaction, UtilityFulfillmentOrder } from '../payments.types'

// PlanetTalk field names that act as a client-supplied idempotency/reference key. If the biller
// exposes one we pass `pi_<intentId>`, giving provider-side dedup against a double submission.
const REFERENCE_FIELD_NAMES = ['reference', 'requestId', 'request_id', 'merchantReference']

/**
 * Normalise a Nigerian phone number to the local `0XXXXXXXXXX` format Buhibab expects, mirroring
 * `planettalk-topup.executor.ts`. The utility phone field may carry the number WITHOUT its dial
 * code, so a value like `8012345678` or `2348012345678` must be brought back to `08012345678`
 * before it is submitted — otherwise the token could be sent to a malformed number.
 */
function normalizeNigerianPhone(raw: string): string {
  let phone = raw.replace(/[\s\-()+]/g, '')
  if (phone.startsWith('234') && phone.length > 11) {
    phone = '0' + phone.slice(3)
  }
  if (phone.length === 10 && /^[789]/.test(phone)) {
    phone = '0' + phone
  }
  return phone
}

/**
 * Ported verbatim from TopupApp/src/lib/fulfillment/planettalk-pay-bill.ts
 * (executePlanetTalkPayBill), as an injectable NestJS service using the shared
 * PlanetTalkService for auth/fetch + biller resolution instead of the frontend's
 * `planetTalkFetch`/`fetchAndBuildBillers`.
 *
 * buhibab has NO sandbox — this executor is unit-tested with a mocked
 * PlanetTalkService.fetch only; it must never be exercised against the live API
 * outside a real purchase flow.
 */
@Injectable()
export class PlanetTalkPayBillExecutor {
  constructor(private readonly planetTalk: PlanetTalkService) {}

  async execute(order: UtilityFulfillmentOrder, paymentIntentId: string): Promise<FulfillmentTransaction> {
    if (!this.planetTalk.hasCredentials()) {
      throw new Error('Planet Talk API credentials not configured')
    }

    const billers = await this.planetTalk.fetchAndBuildBillers()
    const biller = billers.find((b) => b.id === order.billerId)

    if (!biller) {
      const err = new Error('Biller not found in Planet Talk products') as Error & { retryable?: boolean }
      err.retryable = false
      throw err
    }

    const formData = new FormData()
    const fieldNames = biller._additionalFields.map((f) => f.name)

    if (fieldNames.includes('billersCode')) {
      formData.append('billersCode', order.accountNumber)
    }
    if (fieldNames.includes('recipient')) {
      formData.append('recipient', order.accountNumber)
    }
    if (fieldNames.includes('phone')) {
      formData.append('phone', order.phone ? normalizeNigerianPhone(order.phone) : order.accountNumber)
    }
    if (!biller._fixedPrice && order.providerAmount) {
      formData.append('amount', String(order.providerAmount))
    }

    // buhibab now requires `email` on every purchase (it also sends its own
    // confirmation email, and returns the electricity token/units in `meta`).
    if (order.email) {
      formData.append('email', order.email)
    }

    if (paymentIntentId) {
      const refField = fieldNames.find((name) => REFERENCE_FIELD_NAMES.includes(name))
      if (refField) formData.append(refField, `pi_${paymentIntentId}`)
    }

    const apiUrl = `${getPlanetTalkUrl()}/products/${biller.id}/purchase`

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
      const err = new Error(responseBody.message || 'Failed to process utility payment') as Error & {
        retryable?: boolean
        statusCode?: number
      }
      err.retryable = purchaseRes.status >= 500
      err.statusCode = purchaseRes.status
      throw err
    }

    return {
      transactionId: String(responseBody.data?.id ?? Date.now()),
      billerId: biller.id,
      billerName: biller.name,
      accountNumber: order.accountNumber,
      amount: responseBody.data?.amount ?? order.providerAmount,
      currency: 'NGN',
      status:
        responseBody.data?.status === 'completed'
          ? 'SUCCESSFUL'
          : responseBody.data?.status?.toUpperCase(),
      referenceId: responseBody.data?.reference ?? order.referenceId,
      // Electricity returns { token, units, ... } here; other utilities return null.
      meta: responseBody.data?.meta ?? responseBody.meta ?? null,
      timestamp: new Date().toISOString(),
      provider: 'planettalk',
    }
  }
}
