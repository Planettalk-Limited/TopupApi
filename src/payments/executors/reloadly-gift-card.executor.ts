import { Injectable } from '@nestjs/common'
import { ReloadlyService } from '../../providers/reloadly/reloadly.service'
import type { FulfillmentTransaction, GiftCardFulfillmentOrder, GiftCardRedeemInfo } from '../payments.types'

/**
 * Ported verbatim from TopupApp/src/lib/fulfillment/reloadly-gift-card.ts
 * (executeReloadlyGiftCardPurchase + fetchReloadlyGiftCardRedeemCode), as an
 * injectable NestJS service using the shared ReloadlyService for auth/fetch.
 */
@Injectable()
export class ReloadlyGiftCardExecutor {
  constructor(private readonly reloadly: ReloadlyService) {}

  async execute(
    order: GiftCardFulfillmentOrder,
    paymentIntentId: string
  ): Promise<{ transaction: FulfillmentTransaction; giftCard?: GiftCardRedeemInfo }> {
    if (!this.reloadly.hasCredentials()) {
      throw new Error('Reloadly API credentials not configured')
    }

    const apiUrl = this.reloadly.getUrl('giftcards')

    const orderPayload: Record<string, unknown> = {
      productId: order.productId,
      countryCode: order.countryCode,
      quantity: 1,
      unitPrice: order.providerAmount,
      customIdentifier: `pi_${paymentIntentId}`,
    }

    if (order.recipientEmail) {
      orderPayload.recipientEmail = order.recipientEmail
    }

    let purchaseResponse: Awaited<ReturnType<ReloadlyService['fetch']>>
    try {
      purchaseResponse = await this.reloadly.fetch('giftcards', `${apiUrl}/orders`, {
        method: 'POST',
        headers: { Accept: 'application/com.reloadly.giftcards-v1+json' },
        body: JSON.stringify(orderPayload),
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

    if (!purchaseResponse.ok) {
      const errorData = await purchaseResponse.json().catch(() => ({}))
      const err = new Error(errorData.message || 'Failed to process gift card purchase') as Error & {
        retryable?: boolean
        errorCode?: string
        statusCode?: number
      }
      err.retryable = purchaseResponse.status >= 500
      err.errorCode = errorData.errorCode
      err.statusCode = purchaseResponse.status
      throw err
    }

    const purchaseResult = await purchaseResponse.json()
    const transactionId = String(purchaseResult.transactionId)

    const transaction: FulfillmentTransaction = {
      transactionId,
      productId: purchaseResult.productId ?? order.productId,
      productName: order.productName || purchaseResult.product?.productName,
      amount: purchaseResult.amount ?? order.providerAmount,
      currency: purchaseResult.currencyCode ?? order.providerCurrency,
      status: purchaseResult.status,
      cardCode: purchaseResult.cardCode,
      cardPin: purchaseResult.pin,
      timestamp: new Date().toISOString(),
      provider: 'reloadly',
    }

    let giftCard: GiftCardRedeemInfo | undefined

    if (purchaseResult.cardCode) {
      giftCard = {
        cardCode: purchaseResult.cardCode,
        cardPin: purchaseResult.pin,
      }
    } else {
      giftCard = await this.fetchGiftCardRedeemCode(transactionId)
    }

    return { transaction, giftCard }
  }

  async fetchGiftCardRedeemCode(transactionId: string): Promise<GiftCardRedeemInfo | undefined> {
    if (!this.reloadly.hasCredentials()) return undefined

    const apiUrl = this.reloadly.getUrl('giftcards')

    const response = await this.reloadly.fetch(
      'giftcards',
      `${apiUrl}/orders/transactions/${transactionId}/cards`,
      {
        method: 'GET',
        headers: { Accept: 'application/com.reloadly.giftcards-v2+json' },
      }
    )

    if (!response.ok) return undefined

    const redeemData = await response.json()
    const cardCode =
      redeemData.cardNumber?.toString() ||
      redeemData.code ||
      redeemData.cardCode ||
      redeemData.redemptionCode
    const cardPin = redeemData.pinCode || redeemData.pin || redeemData.cardPin
    const isSandbox = apiUrl.includes('sandbox')

    if (!cardCode && isSandbox) {
      return {
        cardCode: `TEST-${transactionId}`,
        cardPin: cardPin || 'TEST-PIN',
        redemptionUrl: redeemData.redemptionUrl,
        isSandboxTest: true,
      }
    }

    if (!cardCode) return undefined

    return {
      cardCode,
      cardPin,
      redemptionUrl: redeemData.redemptionUrl,
    }
  }
}
