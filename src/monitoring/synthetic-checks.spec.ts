import { Probe, ProbeError } from './http-probe'
import { buildSyntheticChecks, SyntheticCheckConfig } from './synthetic-checks'

const base: SyntheticCheckConfig = {
  apiBaseUrl: 'http://api.test/api',
  siteBaseUrl: 'https://site.test',
  siteAliasUrls: ['https://www.site.test'],
  ngProvider: 'reloadly',
  topupCountry: 'GH',
  giftCardCountry: 'US',
  vouchersEnabled: false,
  healthcareEnabled: false,
  healthcareQuery: 'paracetamol',
}

const ids = (cfg: Partial<SyntheticCheckConfig> = {}) => buildSyntheticChecks({ ...base, ...cfg }).map((c) => c.id)
const byId = (id: string, cfg: Partial<SyntheticCheckConfig> = {}) =>
  buildSyntheticChecks({ ...base, ...cfg }).find((c) => c.id === id)!

function fakeProbe(overrides: Partial<Probe> = {}): Probe {
  return {
    getJson: jest.fn().mockResolvedValue([{ id: 1 }]),
    postJson: jest.fn().mockResolvedValue({ amount: 5 }),
    getPage: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('buildSyntheticChecks', () => {
  it('covers top-up, utilities, gift cards and the public pages by default', () => {
    expect(ids()).toEqual([
      'topup-countries',
      'topup-operators-ng',
      'topup-operators-intl',
      'utility-countries',
      'utility-billers-ng',
      'gift-card-countries',
      'gift-cards',
      'site-home',
      'site-utility',
      'site-utilities',
      'site-gift-cards',
      'site-groceries',
      'site-make-calls',
      'site-alias-www.site.test',
    ])
  })

  it('hits the same API paths the site does', () => {
    const targets = Object.fromEntries(buildSyntheticChecks(base).map((c) => [c.id, c.target]))
    expect(targets).toMatchObject({
      'topup-countries': 'http://api.test/api/reloadly/topup-countries',
      'topup-operators-ng': 'http://api.test/api/reloadly/operators?countryCode=NG',
      'topup-operators-intl': 'http://api.test/api/reloadly/operators?countryCode=GH',
      'utility-countries': 'http://api.test/api/reloadly/utility-countries',
      'utility-billers-ng': 'http://api.test/api/reloadly/billers?countryCode=NG',
      'gift-card-countries': 'http://api.test/api/reloadly/gift-cards/countries',
      'gift-cards': 'http://api.test/api/reloadly/gift-cards?countryCode=US',
      'site-home': 'https://site.test/',
      'site-utility': 'https://site.test/utility',
      'site-alias-www.site.test': 'https://www.site.test/',
    })
  })

  it('routes Nigerian top-up/utility checks to planettalk when TOPUP_PROVIDER_NG=planettalk', () => {
    expect(byId('topup-operators-ng', { ngProvider: 'planettalk' }).target).toBe(
      'http://api.test/api/planettalk/operators?countryCode=NG',
    )
    expect(byId('utility-billers-ng', { ngProvider: 'planettalk' }).target).toBe(
      'http://api.test/api/planettalk/billers?countryCode=NG',
    )
  })

  it('only checks vouchers and healthcare (API and pages) when their feature flags are on', () => {
    expect(ids().some((id) => id.includes('voucher') || id.includes('healthcare'))).toBe(false)
    expect(ids({ vouchersEnabled: true, healthcareEnabled: true })).toEqual(
      expect.arrayContaining([
        'vouchers-groceries',
        'vouchers-gift',
        'healthcare',
        'site-gift-vouchers',
        'site-healthcare',
      ]),
    )
  })

  it('drops every page check when the site URL is empty', () => {
    expect(ids({ siteBaseUrl: '' }).some((id) => id.startsWith('site-'))).toBe(false)
  })

  it('gives every check a unique id', () => {
    const all = ids({ vouchersEnabled: true, healthcareEnabled: true })
    expect(new Set(all).size).toBe(all.length)
  })

  describe('check behaviour', () => {
    it('passes a non-empty list', async () => {
      await expect(byId('gift-cards').run(fakeProbe())).resolves.toBeUndefined()
    })

    it('fails an empty catalogue (a page with nothing to buy is broken)', async () => {
      const probe = fakeProbe({ getJson: jest.fn().mockResolvedValue([]) })
      await expect(byId('utility-billers-ng').run(probe)).rejects.toThrow('no billers returned')
    })

    it('fails a non-list response', async () => {
      const probe = fakeProbe({ getJson: jest.fn().mockResolvedValue({ error: 'x' }) })
      await expect(byId('topup-countries').run(probe)).rejects.toThrow(ProbeError)
    })

    it('propagates HTTP errors from the probe', async () => {
      const probe = fakeProbe({ getJson: jest.fn().mockRejectedValue(new ProbeError('HTTP 503')) })
      await expect(byId('topup-countries').run(probe)).rejects.toThrow('HTTP 503')
    })

    it('voucher check lists then quotes the first voucher at its minimum (never a purchase)', async () => {
      const probe = fakeProbe({ getJson: jest.fn().mockResolvedValue([{ id: 4334, minAmount: 1000 }]) })
      await byId('vouchers-groceries', { vouchersEnabled: true }).run(probe)
      expect(probe.getJson).toHaveBeenCalledWith('http://api.test/api/planettalk/vouchers?category=groceries')
      expect(probe.postJson).toHaveBeenCalledWith('http://api.test/api/payments/vouchers/quote', {
        productId: 4334,
        amount: 1000,
      })
    })

    it('healthcare check searches then quotes the first drug, and fails on a zero quote', async () => {
      const probe = fakeProbe({
        getJson: jest.fn().mockResolvedValue([{ drugName: 'Paracetamol 500mg' }]),
        postJson: jest.fn().mockResolvedValue({ amount: 0 }),
      })
      const check = byId('healthcare', { healthcareEnabled: true })
      await expect(check.run(probe)).rejects.toThrow('healthcare quote returned no usable amount')
      expect(probe.getJson).toHaveBeenCalledWith(
        'http://api.test/api/planettalk/healthcare/drugs/search?query=paracetamol',
      )
      expect(probe.postJson).toHaveBeenCalledWith('http://api.test/api/payments/healthcare/quote', {
        drugs: [{ drugName: 'Paracetamol 500mg', quantity: 1 }],
      })
    })

    it('page checks GET the page', async () => {
      const probe = fakeProbe()
      await byId('site-utilities').run(probe)
      expect(probe.getPage).toHaveBeenCalledWith('https://site.test/utilities')
    })

    it('never POSTs to anything but a quote endpoint', async () => {
      const probe = fakeProbe({
        getJson: jest.fn().mockResolvedValue([{ id: 1, minAmount: 1, drugName: 'x' }]),
      })
      for (const check of buildSyntheticChecks({ ...base, vouchersEnabled: true, healthcareEnabled: true })) {
        await check.run(probe)
      }
      const posted = (probe.postJson as jest.Mock).mock.calls.map(([url]) => url)
      expect(posted.length).toBeGreaterThan(0)
      for (const url of posted) expect(url).toMatch(/\/quote$/)
    })
  })
})
