import { ReloadlyTopupExecutor } from './reloadly-topup.executor'
import type { TopupFulfillmentOrder } from '../payments.types'

const order: TopupFulfillmentOrder = {
  productType: 'topup', countryCode: 'GB', operatorId: 1, recipientPhone: '+447860980321',
  providerAmount: 10, providerCurrency: 'GBP', useLocalAmount: false,
}

const okFetch = () => jest.fn().mockResolvedValue({ ok: true, json: async () => ({ transactionId: 555, status: 'SUCCESSFUL', deliveryStatus: 'DELIVERED' }) })
const reloadlyWith = (fetch: jest.Mock) => ({ hasCredentials: () => true, getUrl: () => 'https://topups.reloadly.com', fetch }) as any
const sentNumber = (fetch: jest.Mock) => JSON.parse(fetch.mock.calls[0][2].body).recipientPhone.number

describe('ReloadlyTopupExecutor', () => {
  it('returns a transaction on success and sends customIdentifier pi_<id>', async () => {
    const fetch = okFetch()
    const tx = await new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute(order, '123')
    expect(tx.transactionId).toBe('555')
    const body = JSON.parse(fetch.mock.calls[0][2].body)
    expect(body.customIdentifier).toBe('pi_123') // executor sends `pi_${paymentIntentId}`
  })

  // Reloadly reads recipientPhone.number as the full dialling-code-prefixed number and
  // re-prefixes the country code when it is absent. Stripping the code made it rebuild a
  // wrong number and reject the top-up with "Recipient phone number is not valid" AFTER
  // the customer was charged. See src/common/phone.ts.
  describe('recipientPhone.number is the full E.164 digit string', () => {
    it.each([
      ['GB', '+447860980321', '447860980321', 'E.164 with plus'],
      ['GB', '447860980321', '447860980321', 'E.164 digits without plus'],
      ['GB', '07860980321', '447860980321', 'national with trunk 0'],
      ['GB', '+44 7860 980 321', '447860980321', 'formatted'],
      ['NG', '08012345678', '2348012345678', 'NG national with trunk 0'],
      ['NG', '+2348012345678', '2348012345678', 'NG E.164'],
      ['US', '+14155550123', '14155550123', 'US E.164'],
    ])('%s %s -> %s (%s)', async (countryCode, recipientPhone, expected) => {
      const fetch = okFetch()
      await new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute({ ...order, countryCode, recipientPhone }, '1')
      expect(sentNumber(fetch)).toBe(expected)
    })
  })

  it('still sends the order countryCode alongside the number', async () => {
    const fetch = okFetch()
    await new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute(order, '1')
    expect(JSON.parse(fetch.mock.calls[0][2].body).recipientPhone.countryCode).toBe('GB')
  })

  it('refuses an unusable phone without calling Reloadly, and marks it non-retryable', async () => {
    const fetch = okFetch()
    await expect(
      new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute({ ...order, recipientPhone: '12345' }, 'pi_1')
    ).rejects.toMatchObject({ retryable: false })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not retry a phone the provider can never accept (reconciliation would loop forever)', async () => {
    const fetch = okFetch()
    const err = await new ReloadlyTopupExecutor(reloadlyWith(fetch))
      .execute({ ...order, recipientPhone: 'not a phone' }, 'pi_1')
      .catch((e) => e)
    expect(err.message).toMatch(/phone/i)
    expect(err.statusCode).toBe(400)
  })

  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
    await expect(new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true })
  })

  it('throws retryable when the fetch promise rejects (timeout/connection reset)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    await expect(new ReloadlyTopupExecutor(reloadlyWith(fetch)).execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true })
  })
})
