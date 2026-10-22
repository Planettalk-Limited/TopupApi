import { PlanetTalkVoucherExecutor } from './planettalk-voucher.executor'
import type { VoucherFulfillmentOrder } from '../payments.types'

function order(over: Partial<VoucherFulfillmentOrder> = {}): VoucherFulfillmentOrder {
  return {
    productType: 'voucher',
    countryCode: 'NG',
    providerAmount: 5000,
    providerCurrency: 'NGN',
    productName: 'SPAR gift voucher',
    email: 'buyer@example.com',
    productId: 1957,
    ...over,
  }
}

function respond(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response
}

function build(res: Response) {
  const planetTalk = { hasCredentials: () => true, fetch: jest.fn().mockResolvedValue(res) }
  return { executor: new PlanetTalkVoucherExecutor(planetTalk as any), planetTalk }
}

describe('PlanetTalkVoucherExecutor', () => {
  it('POSTs amount + email to the product purchase route', async () => {
    const { executor, planetTalk } = build(respond(200, { data: { id: 77, status: 'completed', reference: 'REF1' } }))
    const { transaction, giftCard } = await executor.execute(order(), 'pi_1', 'ord_1')

    const [url, init] = planetTalk.fetch.mock.calls[0]
    expect(url).toMatch(/\/products\/1957\/purchase$/)
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ amount: 5000, email: 'buyer@example.com' })
    expect(Array.isArray(body.metadata)).toBe(true)

    expect(transaction).toMatchObject({ transactionId: '77', referenceId: 'REF1', status: 'SUCCESSFUL', currency: 'NGN' })
    expect(giftCard).toBeUndefined()
  })

  it('sends the voucher to the recipient when one is given', async () => {
    const { executor, planetTalk } = build(respond(200, { data: { id: 1, status: 'completed' } }))
    await executor.execute(order({ recipientEmail: 'mum@example.com' }), 'pi_1')
    expect(JSON.parse(planetTalk.fetch.mock.calls[0][1].body).email).toBe('mum@example.com')
  })

  it('returns the code when buhibab includes it, and keeps it out of transaction meta', async () => {
    const { executor } = build(
      respond(200, { data: { id: 1, status: 'completed', meta: { voucher_code: 'SG-1', expiry: '2027-01-01' } } }),
    )
    const { transaction, giftCard } = await executor.execute(order(), 'pi_1')
    expect(giftCard).toEqual({ cardCode: 'SG-1' })
    expect(JSON.stringify(transaction.meta)).not.toContain('SG-1')
    expect(transaction.meta).toMatchObject({ provider: { expiry: '2027-01-01' } })
  })

  it('treats 4xx as final and 5xx as retryable', async () => {
    await expect(build(respond(422, { message: 'bad amount' })).executor.execute(order(), 'pi')).rejects.toMatchObject({
      message: 'bad amount',
      retryable: false,
    })
    await expect(build(respond(503, {})).executor.execute(order(), 'pi')).rejects.toMatchObject({ retryable: true })
  })

  it('refuses a 2xx whose status is failed', async () => {
    await expect(
      build(respond(200, { message: 'out of stock', data: { status: 'failed' } })).executor.execute(order(), 'pi'),
    ).rejects.toMatchObject({ retryable: false })
  })
})
