import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from '../../providers/buhibab/planettalk.service'
import { getPlanetTalkUrl } from '../../providers/buhibab/planettalk.config'
import { buildPurchaseMetadata } from '../../providers/buhibab/purchase-metadata'
import { extractVoucherCode } from '../voucher-order'
import type { FulfillmentTransaction, GiftCardRedeemInfo, VoucherFulfillmentOrder } from '../payments.types'

type ExecutorError = Error & { retryable?: boolean; statusCode?: number }

function executorError(message: string, opts: { retryable: boolean; statusCode?: number }): ExecutorError {
  const err = new Error(message) as ExecutorError
  err.retryable = opts.retryable
  if (opts.statusCode !== undefined) err.statusCode = opts.statusCode
  return err
}

/**
 * Buys a SureGifts voucher via buhibab: `POST /products/{id}/purchase` with a JSON body.
 * The payload contract is undocumented upstream; it was established from the live API's
 * validation errors on 2026-10-19: `amount` (numeric, NGN face value) and `email` are
 * required, and nothing else is. SureGifts delivers the voucher to `email`, so that is the
 * recipient's address when one was given and the buyer's otherwise.
 *
 * If the response also carries the voucher code it is returned as `giftCard` and lands in
 * Fulfillment.meta, where the ownership-guarded gift-card-code endpoint serves it — exactly
 * like a Reloadly gift card. The `metadata` array carries our Stripe payment intent and
 * order id for buhibab's support team.
 */
@Injectable()
export class PlanetTalkVoucherExecutor {
  constructor(private readonly planetTalk: PlanetTalkService) {}

  async execute(
    order: VoucherFulfillmentOrder,
    paymentIntentId: string,
    orderId?: string,
  ): Promise<{ transaction: FulfillmentTransaction; giftCard?: GiftCardRedeemInfo }> {
    if (!this.planetTalk.hasCredentials()) {
      throw new Error('Planet Talk API credentials not configured')
    }

    const payload = {
      amount: order.providerAmount,
      email: order.recipientEmail?.trim() || order.email,
      metadata: buildPurchaseMetadata({ paymentIntentId, orderId }),
    }

    let res: Response
    try {
      res = await this.planetTalk.fetch(`${getPlanetTalkUrl()}/products/${order.productId}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (networkErr) {
      throw executorError(
        networkErr instanceof Error ? networkErr.message : 'Network error calling Planet Talk',
        { retryable: true },
      )
    }

    const body = (await res.json().catch(() => ({}))) as {
      message?: string
      data?: { id?: number | string; amount?: number; status?: string; reference?: string; meta?: unknown }
    }

    if (!res.ok) {
      throw executorError(body.message || 'Failed to buy the gift voucher', {
        retryable: res.status >= 500,
        statusCode: res.status,
      })
    }

    // Defensive: a 2xx whose transaction row still says failed is not a delivered voucher.
    if (body.data?.status === 'failed') {
      throw executorError(body.message || 'The gift voucher was not issued', {
        retryable: false,
        statusCode: 400,
      })
    }

    const code = extractVoucherCode(body.data)
    // The provider's own output minus the code itself, which belongs only in giftCard.
    const providerMeta =
      body.data?.meta && typeof body.data.meta === 'object' && !Array.isArray(body.data.meta)
        ? Object.fromEntries(
            Object.entries(body.data.meta as Record<string, unknown>).filter(
              ([, v]) => v !== code?.cardCode && v !== code?.cardPin,
            ),
          )
        : null

    return {
      transaction: {
        transactionId: String(body.data?.id ?? Date.now()),
        productId: order.productId,
        productName: order.productName,
        amount: body.data?.amount ?? order.providerAmount,
        currency: 'NGN',
        status: body.data?.status === 'completed' ? 'SUCCESSFUL' : body.data?.status?.toUpperCase(),
        referenceId: body.data?.reference,
        meta: {
          deliveredTo: payload.email,
          providerStatus: body.data?.status ?? null,
          ...(providerMeta && Object.keys(providerMeta).length ? { provider: providerMeta } : {}),
        },
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
      },
      ...(code ? { giftCard: code } : {}),
    }
  }
}
