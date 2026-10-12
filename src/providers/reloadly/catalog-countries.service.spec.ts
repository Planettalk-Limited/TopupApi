import { CatalogCountriesService } from './catalog-countries.service'

function json(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) }
}

function fakeRedis() {
  const store = new Map<string, string>()
  return {
    store,
    get: jest.fn(async (k: string) => store.get(k) ?? null),
    setPx: jest.fn(async (k: string, v: string) => {
      store.set(k, v)
    }),
  }
}

const country = (isoName: string, name = isoName) => ({ isoName, name, currencyCode: 'XXX', flag: `${isoName}.svg` })

describe('CatalogCountriesService.utilityCountries', () => {
  const ORIGINAL = process.env.TOPUP_PROVIDER_NG
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TOPUP_PROVIDER_NG
    else process.env.TOPUP_PROVIDER_NG = ORIGINAL
  })

  function setup(opts: { billers: Record<string, unknown>; planetTalkBillers?: unknown[] | Error }) {
    const reloadly = {
      getUrl: jest.fn(() => 'https://utilities'),
      fetch: jest.fn(async (_api: string, url: string) => {
        if (url.endsWith('/countries')) return json([country('NG'), country('KE'), country('GH'), country('UG')])
        const iso = /countryISOCode=([A-Z]{2})/.exec(url)![1]
        const b = opts.billers[iso]
        return b instanceof Error ? json({ message: 'boom' }, false, 500) : json(b ?? [])
      }),
    }
    const planetTalk = {
      fetchAndBuildBillers: jest.fn(async () => {
        if (opts.planetTalkBillers instanceof Error) throw opts.planetTalkBillers
        return opts.planetTalkBillers ?? []
      }),
    }
    const redis = fakeRedis()
    return { reloadly, planetTalk, redis, service: new CatalogCountriesService(reloadly as any, planetTalk as any, redis as any) }
  }

  it('drops countries with no Reloadly billers (KE/UG), keeping the original country objects', async () => {
    delete process.env.TOPUP_PROVIDER_NG
    const { service } = setup({ billers: { NG: [{ id: 1 }], GH: { content: [{ id: 2 }] }, KE: [], UG: { content: [] } } })

    expect(await service.utilityCountries()).toEqual([country('NG'), country('GH')])
  })

  it('judges NG by PlanetTalk billers when TOPUP_PROVIDER_NG=planettalk', async () => {
    process.env.TOPUP_PROVIDER_NG = 'planettalk'
    const withPt = setup({ billers: { NG: [], GH: [{ id: 2 }] }, planetTalkBillers: [{ id: 994 }] })
    expect((await withPt.service.utilityCountries()).map((c) => c.isoName)).toEqual(['NG', 'GH'])
    expect(withPt.reloadly.fetch.mock.calls.some(([, url]) => String(url).includes('countryISOCode=NG'))).toBe(false)

    const withoutPt = setup({ billers: { NG: [{ id: 1 }], GH: [{ id: 2 }] }, planetTalkBillers: [] })
    expect((await withoutPt.service.utilityCountries()).map((c) => c.isoName)).toEqual(['GH'])
  })

  it('caches the filtered list, keyed by the NG provider', async () => {
    delete process.env.TOPUP_PROVIDER_NG
    const { service, reloadly, redis } = setup({ billers: { NG: [{ id: 1 }] } })

    await service.utilityCountries()
    const calls = reloadly.fetch.mock.calls.length
    await service.utilityCountries()

    expect(reloadly.fetch.mock.calls.length).toBe(calls)
    expect([...redis.store.keys()][0]).toContain('reloadly')
  })

  it('does not cache a result built while a country lookup failed (no 6h blackout)', async () => {
    delete process.env.TOPUP_PROVIDER_NG
    const { service, redis } = setup({ billers: { NG: [{ id: 1 }], GH: new Error('down') } })

    const result = await service.utilityCountries()

    expect(result.map((c) => c.isoName)).toEqual(['NG'])
    expect(redis.setPx).not.toHaveBeenCalled()
  })
})

describe('CatalogCountriesService.giftCardCountries', () => {
  function setup(pages: Array<{ content: unknown[]; last: boolean }>) {
    const reloadly = {
      getUrl: jest.fn(() => 'https://giftcards'),
      fetch: jest.fn(async (_api: string, url: string) => {
        if (url.endsWith('/countries')) {
          return json([
            { isoName: 'US', name: 'United States', flagUrl: 'us.svg', extra: 1 },
            { isoName: 'GB', name: 'United Kingdom', flagUrl: 'gb.svg' },
            { isoName: 'ZW', name: 'Zimbabwe', flagUrl: 'zw.svg' },
          ])
        }
        const page = Number(/page=(\d+)/.exec(url)![1])
        return json(pages[page - 1])
      }),
    }
    const redis = fakeRedis()
    return { reloadly, redis, service: new CatalogCountriesService(reloadly as any, {} as any, redis as any) }
  }

  it('returns only countries with at least one allowed product, across all pages', async () => {
    const { service, reloadly } = setup([
      // productId 5 is allow-listed; 999999 is not.
      { content: [{ productId: 999999, country: { isoName: 'ZW' } }, { productId: 5, country: { isoName: 'US' } }], last: false },
      { content: [{ productId: 12, country: { isoName: 'GB' } }], last: true },
    ])

    expect(await service.giftCardCountries()).toEqual([
      { isoName: 'US', name: 'United States', flagUrl: 'us.svg' },
      { isoName: 'GB', name: 'United Kingdom', flagUrl: 'gb.svg' },
    ])
    expect(reloadly.fetch.mock.calls.filter(([, url]) => String(url).includes('/products?')).length).toBe(2)
  })

  it('is cached', async () => {
    const { service, reloadly } = setup([{ content: [{ productId: 5, country: { isoName: 'US' } }], last: true }])
    await service.giftCardCountries()
    const calls = reloadly.fetch.mock.calls.length
    await service.giftCardCountries()
    expect(reloadly.fetch.mock.calls.length).toBe(calls)
  })
})
