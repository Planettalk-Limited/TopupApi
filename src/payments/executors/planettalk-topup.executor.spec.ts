import { PlanetTalkTopupExecutor } from './planettalk-topup.executor'
import type { TopupFulfillmentOrder } from '../payments.types'
import type { BuildResult } from '../../providers/buhibab/planettalk.mappers'

const order: TopupFulfillmentOrder = {
  productType: 'topup',
  countryCode: 'NG',
  operatorId: 100,
  recipientPhone: '08012345678',
  providerAmount: 200,
  providerCurrency: 'NGN',
  useLocalAmount: true,
  email: 'buyer@example.com',
}

function buildResult(overrides: Partial<BuildResult['productMap'][string]> = {}): BuildResult {
  return {
    operators: [],
    productMap: {
      '100_200': {
        productId: 555,
        productName: 'MTN NG 200',
        fixedPrice: true,
        additionalFields: [
          { name: 'phone', required: true },
          { name: 'reference', required: false },
        ],
        ...overrides,
      },
    },
  }
}

function makeExecutor(opts: {
  hasCredentials?: boolean
  buildResult?: BuildResult
  fetch?: jest.Mock
}) {
  const planetTalk = {
    hasCredentials: jest.fn().mockReturnValue(opts.hasCredentials ?? true),
    fetchAndBuildOperators: jest.fn().mockResolvedValue(opts.buildResult ?? buildResult()),
    fetch: opts.fetch ?? jest.fn(),
  } as any
  return { executor: new PlanetTalkTopupExecutor(planetTalk), planetTalk }
}

describe('PlanetTalkTopupExecutor', () => {
  it('returns a transaction on success, appends email + a pi_<id> reference, and normalises the phone', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 999, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute(order, '123')

    expect(tx.transactionId).toBe('999')
    expect(tx.status).toBe('completed')
    expect(tx.deliveryStatus).toBe('DELIVERED')
    expect(tx.currency).toBe('NGN')
    expect(tx.amount).toBe(200)
    expect(tx.recipientPhone).toBe('08012345678')
    expect(tx.provider).toBe('planettalk')
    // Airtime/data returns null meta.
    expect(tx.meta).toBeNull()

    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, opts] = fetch.mock.calls[0]
    expect(url).toContain('/products/555/purchase')
    expect(opts.method).toBe('POST')
    const body = opts.body as FormData
    expect(body.get('phone')).toBe('08012345678')
    expect(body.get('email')).toBe('buyer@example.com')
    expect(body.get('reference')).toBe('pi_123')
    // fixedPrice product must not carry an `amount` field.
    expect(body.get('amount')).toBeNull()
  })

  it('normalises a 234-prefixed phone number to the local 0-prefixed format', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 1, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute({ ...order, recipientPhone: '2348012345678' }, '123')

    expect(tx.recipientPhone).toBe('08012345678')
    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('phone')).toBe('08012345678')
  })

  it('normalises a bare 10-digit mobile number (78/79-prefixed) to the local 0-prefixed format', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 1, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute({ ...order, recipientPhone: '8012345678' }, '123')

    expect(tx.recipientPhone).toBe('08012345678')
  })

  it('omits email when the order carries none', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 1, status: 'completed' } }),
    })
    const { executor } = makeExecutor({ fetch })

    await executor.execute({ ...order, email: undefined }, '123')

    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('email')).toBeNull()
  })

  it('sends the `amount` field for a variable-price product', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 1, status: 'completed' } }),
    })
    const buildResult: BuildResult = {
      operators: [],
      productMap: {
        '100_var': {
          productId: 777,
          productName: 'MTN NG variable',
          fixedPrice: false,
          additionalFields: [{ name: 'phone', required: true }],
        },
      },
    }
    const { executor } = makeExecutor({ fetch, buildResult })

    await executor.execute({ ...order, providerAmount: 350 }, '123')

    const body = fetch.mock.calls[0][1].body as FormData
    expect(body.get('amount')).toBe('350')
  })

  it('captures provider-returned meta into transaction.meta when present', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: { transaction_id: 1, status: 'completed', meta: { token: 'abc', units: '10kWh' } } }),
    })
    const { executor } = makeExecutor({ fetch })

    const tx = await executor.execute(order, '123')

    expect(tx.meta).toEqual({ token: 'abc', units: '10kWh' })
  })

  it('throws when Planet Talk credentials are not configured', async () => {
    const { executor, planetTalk } = makeExecutor({ hasCredentials: false })
    await expect(executor.execute(order, '123')).rejects.toThrow('Planet Talk API credentials not configured')
    expect(planetTalk.fetch).not.toHaveBeenCalled()
  })

  it('throws when the order is not for Nigeria', async () => {
    const { executor } = makeExecutor({})
    await expect(executor.execute({ ...order, countryCode: 'GB' }, '123')).rejects.toThrow(
      'Planet Talk topup is only available for Nigeria (NG)'
    )
  })

  it('throws a non-retryable error when no matching product is found', async () => {
    const { executor } = makeExecutor({ buildResult: { operators: [], productMap: {} } })
    await expect(executor.execute(order, '123')).rejects.toMatchObject({ retryable: false })
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
