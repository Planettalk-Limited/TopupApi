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

/** The shape buhibab returned on the first live voucher order (2026-10-22). */
const ISSUED = {
  id: 77,
  status: 'completed',
  reference: 'REF1',
  meta: {
    vouchers: [{ pin: '7545', code: '321154121525', value: 5000, serial: 301126367, expiry_date: '2027-10-22T11:48:04Z' }],
    order_number: '453988',
  },
}

function build(res: Response) {
  const planetTalk = { hasCredentials: () => true, fetch: jest.fn().mockResolvedValue(res) }
  const alert = { notify: jest.fn().mockResolvedValue(undefined) }
  return { executor: new PlanetTalkVoucherExecutor(planetTalk as any, alert as any), planetTalk, alert }
}

describe('PlanetTalkVoucherExecutor', () => {
  it('POSTs amount + email to the product purchase route', async () => {
    const { executor, planetTalk } = build(respond(200, { data: ISSUED }))
    const { transaction } = await executor.execute(order(), 'pi_1', 'ord_1')

    const [url, init] = planetTalk.fetch.mock.calls[0]
    expect(url).toMatch(/\/products\/1957\/purchase$/)
    const body = JSON.parse(init.body)
    expect(body).toMatchObject({ amount: 5000, email: 'buyer@example.com' })
    expect(Array.isArray(body.metadata)).toBe(true)

    expect(transaction).toMatchObject({ transactionId: '77', referenceId: 'REF1', status: 'SUCCESSFUL', currency: 'NGN' })
  })

  it('names the recipient as the purchase email when one is given', async () => {
    const { executor, planetTalk } = build(respond(200, { data: ISSUED }))
    await executor.execute(order({ recipientEmail: 'mum@example.com' }), 'pi_1')
    expect(JSON.parse(planetTalk.fetch.mock.calls[0][1].body).email).toBe('mum@example.com')
  })

  it('returns the issued vouchers, and keeps codes out of the stored provider echo', async () => {
    const { executor } = build(respond(200, { data: ISSUED }))
    const { transaction, giftCard, vouchers } = await executor.execute(order(), 'pi_1')

    expect(giftCard).toEqual({ cardCode: '321154121525', cardPin: '7545' })
    expect(vouchers).toEqual([
      { code: '321154121525', pin: '7545', serial: '301126367', expiresAt: '2027-10-22T11:48:04Z', value: 5000 },
    ])
    expect(transaction.meta).toMatchObject({ provider: { order_number: '453988' }, providerStatus: 'completed' })
    expect(JSON.stringify(transaction.meta)).not.toContain('321154121525')
    expect(JSON.stringify(transaction.meta)).not.toContain('7545')
  })

  it.each([
    ['completed with no vouchers', { id: 1, status: 'completed', meta: { order_number: '1' } }],
    ['completed with meta null', { id: 1, status: 'completed', meta: null }],
    ['still pending', { ...ISSUED, status: 'pending' }],
    ['no status at all', { id: 1 }],
  ])('refuses a voucher it cannot deliver (%s), finally, and alerts ops', async (_label, data) => {
    const { executor, alert } = build(respond(200, { data }))
    await expect(executor.execute(order(), 'pi_1', 'ord_1')).rejects.toMatchObject({ retryable: false })
    expect(alert.notify).toHaveBeenCalledWith(expect.stringContaining('ord_1'), 'critical')
  })

  it('treats a 4xx as a final refusal, without alerting (nothing was bought)', async () => {
    const { executor, alert } = build(respond(422, { message: 'bad amount' }))
    await expect(executor.execute(order(), 'pi')).rejects.toMatchObject({ message: 'bad amount', retryable: false })
    expect(alert.notify).not.toHaveBeenCalled()
  })

  it('never retries a purchase whose outcome is unknown (5xx), and alerts ops', async () => {
    const { executor, alert } = build(respond(503, { message: 'upstream timeout' }))
    await expect(executor.execute(order(), 'pi_1', 'ord_1')).rejects.toMatchObject({
      retryable: false,
      exhaustAttempts: true,
    })
    expect(alert.notify).toHaveBeenCalledWith(expect.stringContaining('ord_1'), 'critical')
  })

  it('never retries when the connection fails mid-purchase, and alerts ops', async () => {
    const planetTalk = { hasCredentials: () => true, fetch: jest.fn().mockRejectedValue(new Error('socket hang up')) }
    const alert = { notify: jest.fn().mockResolvedValue(undefined) }
    const executor = new PlanetTalkVoucherExecutor(planetTalk as any, alert as any)
    await expect(executor.execute(order(), 'pi_1', 'ord_1')).rejects.toMatchObject({
      retryable: false,
      exhaustAttempts: true,
    })
    expect(alert.notify).toHaveBeenCalledWith(expect.stringContaining('socket hang up'), 'critical')
  })

  it('refuses a 2xx whose status is failed, without alerting (nothing was issued)', async () => {
    const { executor, alert } = build(respond(200, { message: 'out of stock', data: { status: 'failed' } }))
    await expect(executor.execute(order(), 'pi')).rejects.toMatchObject({ retryable: false })
    expect(alert.notify).not.toHaveBeenCalled()
  })
})
