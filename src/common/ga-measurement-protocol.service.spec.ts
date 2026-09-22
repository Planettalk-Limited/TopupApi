import { Test } from '@nestjs/testing'
import { ConfigService } from '@nestjs/config'
import { GaMeasurementProtocolService } from './ga-measurement-protocol.service'

const TOPUP_ID = 'G-TOPUP123'
const TOPUP_SECRET = 'topup-secret'
const MARKETING_ID = 'G-MARKET456'
const MARKETING_SECRET = 'marketing-secret'

const basePurchase = {
  transactionId: 'order-abc',
  value: 12.5,
  currency: 'GBP',
  clientId: '1234567890.9876543210',
  sessions: { [TOPUP_ID]: '1750000000', [MARKETING_ID]: '1750000111' },
  vertical: 'mobile_topup' as const,
  countryCode: 'NG',
  provider: 'PLANETTALK',
  productName: 'MTN 1000 NGN',
}

function buildService(env: Record<string, string | undefined>) {
  return Test.createTestingModule({
    providers: [
      GaMeasurementProtocolService,
      { provide: ConfigService, useValue: { get: (k: string) => env[k] } },
    ],
  })
    .compile()
    .then((m) => m.get(GaMeasurementProtocolService))
}

const fullEnv = {
  GA_TOPUP_MEASUREMENT_ID: TOPUP_ID,
  GA_TOPUP_API_SECRET: TOPUP_SECRET,
  GA_MARKETING_MEASUREMENT_ID: MARKETING_ID,
  GA_MARKETING_API_SECRET: MARKETING_SECRET,
}

describe('GaMeasurementProtocolService', () => {
  let fetchMock: jest.Mock

  beforeEach(() => {
    fetchMock = jest.fn().mockResolvedValue({ ok: true, status: 204, text: async () => '' })
    global.fetch = fetchMock as unknown as typeof fetch
    jest.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => jest.restoreAllMocks())

  it('posts one purchase event per configured property', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase(basePurchase)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    const urls = fetchMock.mock.calls.map((c) => String(c[0]))
    expect(urls).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`measurement_id=${TOPUP_ID}&api_secret=${TOPUP_SECRET}`),
        expect.stringContaining(`measurement_id=${MARKETING_ID}&api_secret=${MARKETING_SECRET}`),
      ]),
    )
    urls.forEach((u) => expect(u.startsWith('https://www.google-analytics.com/mp/collect?')).toBe(true))
  })

  it('sends a GA4-shaped purchase payload with the per-property session id', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase(basePurchase)

    const topupCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(TOPUP_ID))!
    const body = JSON.parse(topupCall[1].body)

    expect(body.client_id).toBe('1234567890.9876543210')
    expect(body.non_personalized_ads).toBe(true)
    expect(body.events).toHaveLength(1)

    const event = body.events[0]
    expect(event.name).toBe('purchase')
    expect(event.params.transaction_id).toBe('order-abc')
    expect(event.params.value).toBe(12.5)
    expect(event.params.currency).toBe('GBP')
    expect(event.params.session_id).toBe('1750000000')
    expect(event.params.engagement_time_msec).toBe(1)
    expect(event.params.items).toEqual([
      expect.objectContaining({
        item_id: 'mobile_topup',
        item_name: 'MTN 1000 NGN',
        item_category: 'mobile_topup',
        item_brand: 'PLANETTALK',
        price: 12.5,
        quantity: 1,
      }),
    ])
  })

  it('uses each property its own session id', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase(basePurchase)

    const marketingCall = fetchMock.mock.calls.find((c) => String(c[0]).includes(MARKETING_ID))!
    expect(JSON.parse(marketingCall[1].body).events[0].params.session_id).toBe('1750000111')
  })

  it('skips a property that is missing its api secret', async () => {
    const svc = await buildService({ ...fullEnv, GA_MARKETING_API_SECRET: undefined })
    await svc.sendPurchase(basePurchase)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(String(fetchMock.mock.calls[0][0])).toContain(TOPUP_ID)
  })

  it('does nothing when no property is configured', async () => {
    const svc = await buildService({})
    await expect(svc.sendPurchase(basePurchase)).resolves.toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('falls back to a deterministic synthetic client id when none was captured', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase({ ...basePurchase, clientId: null })

    const first = JSON.parse(fetchMock.mock.calls[0][1].body).client_id
    expect(first).toMatch(/^\d{10}\.\d{10}$/)

    fetchMock.mockClear()
    await svc.sendPurchase({ ...basePurchase, clientId: null })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).client_id).toBe(first)
  })

  it('omits session_id rather than sending a bogus one when it was not captured', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase({ ...basePurchase, sessions: null })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.events[0].params).not.toHaveProperty('session_id')
  })

  it('never throws when the GA endpoint rejects', async () => {
    fetchMock.mockRejectedValue(new Error('network down'))
    const svc = await buildService(fullEnv)

    await expect(svc.sendPurchase(basePurchase)).resolves.toBeUndefined()
  })

  it('never throws when one property fails and still delivers the other', async () => {
    fetchMock.mockImplementation((url: string) =>
      String(url).includes(TOPUP_ID)
        ? Promise.reject(new Error('boom'))
        : Promise.resolve({ ok: true, status: 204, text: async () => '' }),
    )
    const svc = await buildService(fullEnv)

    await expect(svc.sendPurchase(basePurchase)).resolves.toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never throws when GA returns a non-2xx response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' })
    const svc = await buildService(fullEnv)

    await expect(svc.sendPurchase(basePurchase)).resolves.toBeUndefined()
  })

  it('aborts a hung request instead of blocking fulfilment', async () => {
    const svc = await buildService(fullEnv)
    await svc.sendPurchase(basePurchase)

    expect(fetchMock.mock.calls[0][1].signal).toBeDefined()
  })
})
