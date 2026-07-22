import { ReloadlyPayBillExecutor } from './reloadly-pay-bill.executor'
import type { UtilityFulfillmentOrder } from '../payments.types'

const order: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'GB',
  billerId: 7,
  accountNumber: '04223568280',
  providerAmount: 10,
  providerCurrency: 'GBP',
}

describe('ReloadlyPayBillExecutor', () => {
  it('returns a transaction on success and sends billerId/amount/subscriberAccountNumber + a referenceId idempotency key', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 108,
        billerId: 7,
        subscriberAccountNumber: '04223568280',
        amount: 10,
        deliveredAmountCurrencyCode: 'GBP',
        status: 'SUCCESSFUL',
        referenceId: 'pi_123',
      }),
    })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any

    const tx = await new ReloadlyPayBillExecutor(reloadly).execute(order, '123')

    expect(tx.transactionId).toBe('108')
    expect(tx.billerId).toBe(7)
    expect(tx.accountNumber).toBe('04223568280')
    expect(tx.amount).toBe(10)
    expect(tx.currency).toBe('GBP')
    expect(tx.status).toBe('SUCCESSFUL')
    expect(tx.referenceId).toBe('pi_123')
    expect(tx.provider).toBe('reloadly')
    expect(tx.meta).toBeNull()

    expect(fetch).toHaveBeenCalledTimes(1)
    const [api, url, opts] = fetch.mock.calls[0]
    expect(api).toBe('utilities')
    expect(url).toBe('https://utilities.reloadly.com/pay')
    expect(opts.method).toBe('POST')
    const body = JSON.parse(opts.body)
    expect(body).toEqual({
      subscriberAccountNumber: '04223568280',
      amount: 10,
      useLocalAmount: true,
      billerId: 7,
      referenceId: 'pi_123', // executor sends `pi_${paymentIntentId}` when order carries no referenceId
    })
  })

  it('uses the order-supplied referenceId (idempotency key) instead of deriving one from paymentIntentId when present', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 109, status: 'SUCCESSFUL' }),
    })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any

    await new ReloadlyPayBillExecutor(reloadly).execute({ ...order, referenceId: 'UTL-fixed-ref' }, '123')

    const body = JSON.parse(fetch.mock.calls[0][2].body)
    expect(body.referenceId).toBe('UTL-fixed-ref')
  })

  it('captures provider-returned additionalInfo (e.g. electricity token/units) into transaction.meta', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 110,
        status: 'SUCCESSFUL',
        additionalInfo: { token: '1234-5678-9012-3456', units: '45.2kWh' },
      }),
    })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any

    const tx = await new ReloadlyPayBillExecutor(reloadly).execute(order, '123')

    expect(tx.meta).toEqual({ token: '1234-5678-9012-3456', units: '45.2kWh' })
  })

  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any
    await expect(new ReloadlyPayBillExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: true,
    })
  })

  it('throws non-retryable on 4xx and preserves the provider message/errorCode/statusCode', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Biller is not available', errorCode: 'BILLER_UNAVAILABLE' }),
    })
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any
    await expect(new ReloadlyPayBillExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: false,
      message: 'Biller is not available',
      errorCode: 'BILLER_UNAVAILABLE',
      statusCode: 400,
    })
  })

  it('throws retryable when the fetch promise rejects (timeout/connection reset)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const reloadly = { hasCredentials: () => true, getUrl: () => 'https://utilities.reloadly.com', fetch } as any
    await expect(new ReloadlyPayBillExecutor(reloadly).execute(order, 'pi_1')).rejects.toMatchObject({
      retryable: true,
      message: 'ECONNRESET',
    })
  })

  it('throws when Reloadly credentials are not configured', async () => {
    const reloadly = { hasCredentials: () => false, getUrl: jest.fn(), fetch: jest.fn() } as any
    await expect(new ReloadlyPayBillExecutor(reloadly).execute(order, 'pi_1')).rejects.toThrow(
      'Reloadly API credentials not configured'
    )
    expect(reloadly.fetch).not.toHaveBeenCalled()
  })
})
