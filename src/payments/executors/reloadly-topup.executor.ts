import { Injectable } from '@nestjs/common'
import { ReloadlyService } from '../../providers/reloadly/reloadly.service'
import type { FulfillmentTransaction, TopupFulfillmentOrder } from '../payments.types'

/**
 * Ported verbatim from TopupApp/src/lib/fulfillment/reloadly-topup.ts
 * (executeReloadlyTopup), as an injectable NestJS service.
 */
@Injectable()
export class ReloadlyTopupExecutor {
  constructor(private readonly reloadly: ReloadlyService) {}

  async execute(order: TopupFulfillmentOrder, paymentIntentId: string): Promise<FulfillmentTransaction> {
    if (!this.reloadly.hasCredentials()) {
      throw new Error('Reloadly API credentials not configured')
    }

    const apiUrl = this.reloadly.getUrl('topups')

    let phoneNumber =
      typeof order.recipientPhone === 'string'
        ? order.recipientPhone.replace(/[\s\-\(\)\+]/g, '')
        : String(order.recipientPhone)

    if (typeof phoneNumber === 'string' && phoneNumber.length > 10) {
      const match = phoneNumber.match(/^(\d{1,3})(\d{9,10})$/)
      if (match) {
        phoneNumber = match[2]
      }
    }

    const topupPayload = {
      operatorId: order.operatorId,
      amount: order.providerAmount,
      useLocalAmount: order.useLocalAmount ?? true,
      recipientPhone: {
        countryCode: order.countryCode,
        number: phoneNumber,
      },
      customIdentifier: `pi_${paymentIntentId}`,
    }

    const topupResponse = await this.reloadly.fetch('topups', `${apiUrl}/topups`, {
      method: 'POST',
      headers: { Accept: 'application/com.reloadly.topups-v1+json' },
      body: JSON.stringify(topupPayload),
    })

    if (!topupResponse.ok) {
      const errorData = await topupResponse.json().catch(() => ({}))
      const err = new Error(errorData.message || 'Failed to process top-up') as Error & {
        retryable?: boolean
        errorCode?: string
        statusCode?: number
      }
      err.retryable = topupResponse.status >= 500 || errorData.errorCode === 'OPERATOR_CURRENTLY_UNAVAILABLE'
      err.errorCode = errorData.errorCode
      err.statusCode = topupResponse.status
      throw err
    }

    const topupResult = await topupResponse.json()

    return {
      transactionId: String(topupResult.transactionId),
      operatorTransactionId: topupResult.operatorTransactionId,
      status: topupResult.status,
      deliveryStatus: topupResult.deliveryStatus,
      amount: topupResult.requestedAmount ?? order.providerAmount,
      currency: topupResult.requestedAmountCurrencyCode ?? order.providerCurrency,
      recipientPhone: topupResult.recipientPhone ?? order.recipientPhone,
      timestamp: new Date().toISOString(),
      provider: 'reloadly',
    }
  }
}
