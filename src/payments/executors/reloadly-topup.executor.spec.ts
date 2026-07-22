import { ReloadlyTopupExecutor } from './reloadly-topup.executor'
import type { TopupFulfillmentOrder } from '../payments.types'

const order: TopupFulfillmentOrder = {
  productType: 'topup', countryCode: 'GB', operatorId: 1, recipientPhone: '+447700900000',
  providerAmount: 10, providerCurrency: 'GBP', useLocalAmount: false,
}

describe('ReloadlyTopupExecutor', () => {
  it('returns a transaction on success and sends customIdentifier pi_<id>', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ transactionId: 555, status: 'SUCCESSFUL', deliveryStatus: 'DELIVERED' }) })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://topups.reloadly.com', fetch } as any
    const tx = await new ReloadlyTopupExecutor(reloadly).execute(order, '123')
    expect(tx.transactionId).toBe('555')
    const body = JSON.parse(fetch.mock.calls[0][2].body)
    expect(body.customIdentifier).toBe('pi_123') // executor sends `pi_${paymentIntentId}`
  })
  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://topups.reloadly.com', fetch } as any
    await expect(new ReloadlyTopupExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true })
  })
  it('throws retryable when the fetch promise rejects (timeout/connection reset)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://topups.reloadly.com', fetch } as any
    await expect(new ReloadlyTopupExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({ retryable: true })
  })
})
