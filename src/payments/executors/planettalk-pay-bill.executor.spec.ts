import { PlanetTalkPayBillExecutor } from './planettalk-pay-bill.executor'
import type { UtilityFulfillmentOrder } from '../payments.types'
import type { MappedBiller } from '../../providers/buhibab/planettalk.mappers'

const order: UtilityFulfillmentOrder = {
  productType: 'utility',
  countryCode: 'NG',
  billerId: 42,
  accountNumber: '1234567890',
  providerAmount: 500,
  providerCurrency: 'NGN',
  email: 'buyer@example.com',
}

function makeBiller(overrides: Partial<MappedBiller> = {}): MappedBiller {
  return {
    id: 42,
    name: 'Ikeja Electric',
    type: 'ELECTRICITY_BILL_PAYMENT',
    serviceType: 'Prepaid',
    countryCode: 'NG',
    localAmountSupported: true,
    internationalAmountSupported: false,
    localTransactionCurrencyCode: 'NGN',
    senderCurrencyCode: 'USD',
    fx: { rate: 1550, currencyCode: 'NGN' },
    logoUrls: [],
    minLocalTransactionAmount: 100,
    maxLocalTransactionAmount: 100000,
    localMinAmount: 100,
    localMaxAmount: 100000,
    minAmount: 0.06,
    maxAmount: 64.5,
    localFixedAmounts: [],
    localFixedAmountsDescriptions: {},
    _requiresPhone: true,
    _additionalFields: [
      { name: 'billersCode', required: true, label: 'Meter Number', description: '' },
      { name: 'phone', required: true, label: 'Phone', description: '' },
      { name: 'reference', required: false, label: 'Reference', description: '' },
    ],
    _fixedPrice: false,
    _accountLabel: 'Meter Number',
    _accountPlaceholder: 'Enter your meter number',
    _phoneLabel: 'Phone Number',
    ...overrides,
  }
}

function makeExecutor(opts: { hasCredentials?: boolean; billers?: MappedBiller[]; fetch?: jest.Mock }) {
  const planetTalk = {
    hasCredentials: jest.fn().mockReturnValue(opts.hasCredentials ?? true),
    fetchAndBuildBillers: jest.fn().mockResolvedValue(opts.billers ?? [makeBiller()]),
    fetch: opts.fetch ?? jest.fn(),
  } as any
  return { executor: new PlanetTalkPayBillExecutor(planetTalk), planetTalk }
}

describe('PlanetTalkPayBillExecutor', () => {
  it('returns a transaction on success, appends email + a pi_<id> reference, and captures electricity meta (token/units)', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          id: 321,
          amount: 500,
          status: 'completed',
          reference: 'ref-abc',
          meta: { token: '1234-5678-9012-3456', units: '45.2kWh' },
        },
      }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute(order, '123')

    expect(tx.transactionId).toBe('321')
    expect(tx.billerId).toBe(42)
    expect(tx.billerName).toBe('Ikeja Electric')
    expect(tx.accountNumber).toBe('1234567890')
    expect(tx.amount).toBe(500)
    expect(tx.currency).toBe('NGN')
    expect(tx.status).toBe('SUCCESSFUL')
    expect(tx.referenceId).toBe('ref-abc')
    expect(tx.provider).toBe('planettalk')
    // Electricity purchase captures the delivered token/units.
    expect(tx.meta).toEqual({ token: '1234-5678-9012-3456', units: '45.2kWh' })

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toContain('/products/42/purchase')
    expect(opts.method).toBe('POST')
    const body = opts.body as FormData
    expect(body.get('billersCode')).toBe('1234567890')
    expect(body.get('phone')).toBe('1234567890') // no order.phone supplied -> falls back to accountNumber
    expect(body.get('amount')).toBe('500')
    expect(body.get('email')).toBe('buyer@example.com')
    expect(body.get('reference')).toBe('pi_123')
  })

  it('returns null meta for a non-electricity biller (e.g. cable TV)', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 322, amount: 500, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute(order, '123')

    expect(tx.meta).toBeNull()
  })

  it('normalises order.phone (with 234 dial code) instead of falling back to accountNumber', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 323, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    await executor.execute({ ...order, phone: '2348012345678' }, '123')

    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('phone')).toBe('08012345678')
  })

  it('does not send an `amount` field for a fixed-price biller', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 324, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch, billers: [makeBiller({ _fixedPrice: true })] })

    await executor.execute(order, '123')

    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('amount')).toBeNull()
  })

  it('omits email when the order carries none', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { id: 325, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    await executor.execute({ ...order, email: undefined }, '123')

    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('email')).toBeNull()
  })

  it('throws a non-retryable error when the biller is not found', async () => {
    const { executor } = makeExecutor({ billers: [] })
    await expect(executor.execute(order, '123')).rejects.toMatchObject({ retryable: false })
  })

  it('throws when Planet Talk credentials are not configured', async () => {
    const { executor, planetTalk } = makeExecutor({ hasCredentials: false })
    await expect(executor.execute(order, '123')).rejects.toThrow('Planet Talk API credentials not configured')
    expect(planetTalk.fetch).not.toHaveBeenCalled()
  })

  it('throws retryable on 5xx', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, json: async () => ({ message: 'down' }) })
    const { executor } = makeExecutor({ fetch })
    await expect(executor.execute(order, '123')).rejects.toMatchObject({ retryable: true, statusCode: 503 })
  })

  it('throws non-retryable on 4xx and preserves the provider message', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({ message: 'Action Required' }),
    })
    const { executor } = makeExecutor({ fetch })
    await expect(executor.execute(order, '123')).rejects.toMatchObject({
      retryable: false,
      statusCode: 400,
      message: 'Action Required',
    })
  })

  it('throws retryable when the fetch promise rejects (timeout/connection reset)', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('ECONNRESET'))
    const { executor } = makeExecutor({ fetch })
    await expect(executor.execute(order, '123')).rejects.toMatchObject({ retryable: true })
  })
})
