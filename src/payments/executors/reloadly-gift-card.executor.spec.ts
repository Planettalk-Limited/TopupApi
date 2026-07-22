import { ReloadlyGiftCardExecutor } from './reloadly-gift-card.executor'
import type { GiftCardFulfillmentOrder } from '../payments.types'

const order: GiftCardFulfillmentOrder = {
  productType: 'giftcard',
  countryCode: 'GB',
  productId: 42,
  providerAmount: 25,
  providerCurrency: 'GBP',
  recipientEmail: 'recipient@example.com',
}

describe('ReloadlyGiftCardExecutor', () => {
  it('returns a transaction + giftCard on success and sends customIdentifier pi_<id>', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        transactionId: 777,
        productId: 42,
        amount: 25,
        currencyCode: 'GBP',
        status: 'SUCCESSFUL',
        cardCode: 'CARD-CODE-123',
        pin: '9999',
      }),
    })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://giftcards.reloadly.com', fetch } as any

    const result = await new ReloadlyGiftCardExecutor(reloadly).execute(order, '123')

    expect(result.transaction.transactionId).toBe('777')
    expect(result.giftCard).toEqual({ cardCode: 'CARD-CODE-123', cardPin: '9999' })

    // Only one call — the card code came back inline on the order response, so the
    // redeem-code lookup must not be hit.
    expect(fetch).toHaveBeenCalledTimes(1)
    const [, url, opts] = fetch.mock.calls[0]
    expect(url).toBe('https://giftcards.reloadly.com/orders')
    const body = JSON.parse(opts.body)
    expect(body.customIdentifier).toBe('pi_123') // executor sends `pi_${paymentIntentId}`
    expect(body.productId).toBe(42)
    expect(body.recipientEmail).toBe('recipient@example.com')
  })

  it('falls back to the redeem-code lookup when the order response has no cardCode', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ transactionId: 778, status: 'SUCCESSFUL' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ cardNumber: 'REDEEM-456', pinCode: '1234', redemptionUrl: 'https://redeem.example' }),
      })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://giftcards.reloadly.com', fetch } as any

    const result = await new ReloadlyGiftCardExecutor(reloadly).execute(order, '123')

    expect(fetch).toHaveBeenCalledTimes(2)
    expect(fetch.mock.calls[1][1]).toBe('https://giftcards.reloadly.com/orders/transactions/778/cards')
    expect(result.giftCard).toEqual({
      cardCode: 'REDEEM-456',
      cardPin: '1234',
      redemptionUrl: 'https://redeem.example',
    })
  })

  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://giftcards.reloadly.com', fetch } as any
    await expect(new ReloadlyGiftCardExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: true,
    })
  })

  it('throws non-retryable on 4xx', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, status: 400, json: async () => ({ message: 'bad product' }) })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://giftcards.reloadly.com', fetch } as any
    await expect(new ReloadlyGiftCardExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: false,
      message: 'bad product',
    })
  })

  it('throws retryable when the fetch promise rejects (timeout/connection reset)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://giftcards.reloadly.com', fetch } as any
    await expect(new ReloadlyGiftCardExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: true,
    })
  })

  it('throws when Reloadly credentials are not configured', async () => {
    const reloadly = { hasCredentials: () => false, getUrl: jest.fn(), fetch: jest.fn() } as any
    await expect(new ReloadlyGiftCardExecutor(reloadly).execute(order, 'pi_1')).rejects.toThrow(
      'Reloadly API credentials not configured'
    )
  })
})
