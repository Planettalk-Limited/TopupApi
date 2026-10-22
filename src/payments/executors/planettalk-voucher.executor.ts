import { Injectable } from '@nestjs/common'
import { PlanetTalkService } from '../../providers/buhibab/planettalk.service'
import { getPlanetTalkUrl } from '../../providers/buhibab/planettalk.config'
import { buildPurchaseMetadata } from '../../providers/buhibab/purchase-metadata'
import { AlertService } from '../../common/alert.service'
import { extractIssuedVouchers, type IssuedVoucher } from '../voucher-order'
import type { FulfillmentTransaction, GiftCardRedeemInfo, VoucherFulfillmentOrder } from '../payments.types'

type ExecutorError = Error & { retryable?: boolean; statusCode?: number; exhaustAttempts?: boolean }

function executorError(
  message: string,
  opts: { retryable: boolean; statusCode?: number; exhaustAttempts?: boolean },
): ExecutorError {
  const err = new Error(message) as ExecutorError
  err.retryable = opts.retryable
  if (opts.statusCode !== undefined) err.statusCode = opts.statusCode
  if (opts.exhaustAttempts) err.exhaustAttempts = true
  return err
}

/**
 * Buys a SureGifts voucher via buhibab: `POST /products/{id}/purchase` with a JSON body.
 * The payload contract is undocumented upstream; it was established from the live API's
 * validation errors on 2026-10-19: `amount` (numeric, NGN face value) and `email` are
 * required, and nothing else is. The `metadata` array carries our Stripe payment intent
 * and order id for buhibab's support team.
 *
 * DELIVERY IS OURS. buhibab returns the voucher (code, PIN, expiry) in the response and
 * does not email it to anyone, so a purchase only counts as delivered when the response
 * says `completed` AND carries at least one code. FulfillmentService then emails the
 * vouchers to the recipient. Anything else throws a final error, which releases the
 * customer's card hold — they are never charged for a voucher we cannot hand over.
 */
@Injectable()
export class PlanetTalkVoucherExecutor {
  constructor(
    private readonly planetTalk: PlanetTalkService,
    private readonly alert: AlertService,
  ) {}

  async execute(
    order: VoucherFulfillmentOrder,
    paymentIntentId: string,
    orderId?: string,
  ): Promise<{ transaction: FulfillmentTransaction; giftCard: GiftCardRedeemInfo; vouchers: IssuedVoucher[] }> {
    if (!this.planetTalk.hasCredentials()) {
      throw new Error('Planet Talk API credentials not configured')
    }

    const payload = {
      amount: order.providerAmount,
      email: order.recipientEmail?.trim() || order.email,
      metadata: buildPurchaseMetadata({ paymentIntentId, orderId }),
    }

    // A purchase whose outcome we cannot see (no response, or a buhibab server error) may
    // still have issued a voucher, and the purchase call carries nothing buhibab could
    // dedupe a repeat on. So it is never retried: a retry would risk buying it twice.
    // The hold is released and ops checks buhibab by this order's metadata instead.
    const unknownOutcome = async (detail: string) => {
      await this.alert.notify(
        `Gift voucher purchase outcome unknown (${detail}). Order ${orderId ?? '?'} / ${paymentIntentId}. ` +
          `The customer's hold is being released and it will NOT be retried. Check buhibab for a ` +
          `voucher bought with this payment intent in its metadata before doing anything else.`,
        'critical',
      )
      return executorError(`The gift voucher purchase did not complete (${detail})`, {
        retryable: false,
        statusCode: 502,
        exhaustAttempts: true,
      })
    }

    let res: Response
    try {
      res = await this.planetTalk.fetch(`${getPlanetTalkUrl()}/products/${order.productId}/purchase`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
    } catch (networkErr) {
      throw await unknownOutcome(networkErr instanceof Error ? networkErr.message : 'network error')
    }

    const body = (await res.json().catch(() => ({}))) as {
      message?: string
      data?: { id?: number | string; amount?: number; status?: string; reference?: string; meta?: unknown }
    }

    if (res.status >= 500) {
      throw await unknownOutcome(`buhibab ${res.status}${body.message ? `: ${body.message}` : ''}`)
    }
    if (!res.ok) {
      // A 4xx is buhibab refusing the request, so nothing was bought.
      throw executorError(body.message || 'Failed to buy the gift voucher', {
        retryable: false,
        statusCode: res.status,
      })
    }

    const status = body.data?.status
    if (status === 'failed') {
      throw executorError(body.message || 'The gift voucher was not issued', {
        retryable: false,
        statusCode: 400,
      })
    }

    // From here buhibab has accepted the purchase and may have spent our balance on it, so
    // an undeliverable outcome needs a person: never retried (that would buy a second
    // voucher), and ops is told which buhibab order to chase.
    const vouchers = status === 'completed' ? extractIssuedVouchers(body.data) : []
    if (vouchers.length === 0) {
      const reason =
        status === 'completed' ? 'completed without a voucher code' : `left in status "${status ?? 'unknown'}"`
      await this.alert.notify(
        `Gift voucher purchase ${reason}. Order ${orderId ?? '?'} / ${paymentIntentId}, buhibab ` +
          `reference ${body.data?.reference ?? '?'}. The customer's card hold is being released, so ` +
          `they are not charged — check with buhibab whether a voucher was issued.`,
        'critical',
      )
      throw executorError(`The gift voucher was ${reason}`, { retryable: false, statusCode: 502, exhaustAttempts: true })
    }

    // buhibab's output minus the vouchers themselves: codes and PINs are kept once, in
    // `vouchers` (FulfillmentService), not again in this provider echo.
    const providerMeta =
      body.data?.meta && typeof body.data.meta === 'object' && !Array.isArray(body.data.meta)
        ? Object.fromEntries(Object.entries(body.data.meta as Record<string, unknown>).filter(([k]) => k !== 'vouchers'))
        : {}

    const [first] = vouchers
    return {
      transaction: {
        transactionId: String(body.data?.id ?? Date.now()),
        productId: order.productId,
        productName: order.productName,
        amount: body.data?.amount ?? order.providerAmount,
        currency: 'NGN',
        status: 'SUCCESSFUL',
        referenceId: body.data?.reference,
        meta: {
          deliveredTo: payload.email,
          providerStatus: status,
          ...(Object.keys(providerMeta).length ? { provider: providerMeta } : {}),
        },
        timestamp: new Date().toISOString(),
        provider: 'planettalk',
      },
      giftCard: { cardCode: first.code, ...(first.pin ? { cardPin: first.pin } : {}) },
      vouchers,
    }
  }
}
