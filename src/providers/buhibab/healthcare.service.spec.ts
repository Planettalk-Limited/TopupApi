import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { HealthcareService } from './healthcare.service'
import type { HealthcarePharmacy } from './healthcare.types'

const ph = (code: string, state: string, lga: string, area: string, name = code): HealthcarePharmacy => ({
  pharmacyCode: code,
  pharmacyName: name,
  state,
  lga,
  area,
  address: 'No B88, Awolowo drive',
})

const page1 = [ph('A1', 'Lagos', 'IKeja', 'Festac', 'Zed Pharmacy'), ph('A2', 'Lagos', 'IKeja', 'Allen', 'Alpha Pharmacy')]
const page2 = [ph('B1', 'Anambra', 'Onitsha', 'Main Market'), ph('B2', 'Anambra', 'Awka South', 'Amawbia')]

const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body })

function makeService(opts: { fetch?: jest.Mock; cached?: string | null; products?: unknown } = {}) {
  const fetch =
    opts.fetch ??
    jest.fn(async (url: string) => {
      if (url.includes('page_index=1')) return response(200, { data: page1, pageCount: 2, pageIndex: 1, pageSize: 50 })
      if (url.includes('page_index=2')) return response(200, { data: page2, pageCount: 2, pageIndex: 2, pageSize: 50 })
      throw new Error(`unexpected ${url}`)
    })
  const planetTalk = {
    fetch,
    fetchRawProducts: jest.fn().mockResolvedValue(
      opts.products ?? {
        message: 'ok',
        data: [{ sub_service: { name: 'Pharmacy' }, products: [{ id: 1951, value_amount: 100, price: 0.07 }] }],
      },
    ),
  } as any
  const redis = {
    get: jest.fn().mockResolvedValue(opts.cached ?? null),
    setPx: jest.fn().mockResolvedValue(undefined),
  } as any
  return { service: new HealthcareService(planetTalk, redis), fetch, redis, planetTalk }
}

describe('HealthcareService', () => {
  describe('pharmacies & locations', () => {
    it('pages through every pharmacy with page_index and caches the result', async () => {
      const { service, fetch, redis } = makeService()

      const all = await service.getAllPharmacies()

      expect(all.map((p) => p.pharmacyCode)).toEqual(['A1', 'A2', 'B1', 'B2'])
      expect(fetch).toHaveBeenCalledTimes(2)
      expect(redis.setPx).toHaveBeenCalledWith('planettalk:healthcare:pharmacies', JSON.stringify(all), expect.any(Number))
    })

    it('serves from cache without calling the provider', async () => {
      const { service, fetch } = makeService({ cached: JSON.stringify(page1) })
      await expect(service.listStates()).resolves.toEqual(['Lagos'])
      expect(fetch).not.toHaveBeenCalled()
    })

    it('derives states, LGAs and cities (areas) from the list, case-insensitively', async () => {
      const { service } = makeService()
      await expect(service.listStates()).resolves.toEqual(['Anambra', 'Lagos'])
      await expect(service.listLgas('anambra')).resolves.toEqual(['Awka South', 'Onitsha'])
      await expect(service.listCities('Lagos', 'ikeja')).resolves.toEqual(['Allen', 'Festac'])
    })

    it('filters pharmacies by state, LGA and city, sorted by name', async () => {
      const { service } = makeService()
      const lagos = await service.listPharmacies({ state: 'Lagos', lga: 'IKeja' })
      expect(lagos.map((p) => p.pharmacyName)).toEqual(['Alpha Pharmacy', 'Zed Pharmacy'])
      const festac = await service.listPharmacies({ state: 'Lagos', lga: 'IKeja', city: 'festac' })
      expect(festac.map((p) => p.pharmacyCode)).toEqual(['A1'])
    })

    it('finds a pharmacy by exact code', async () => {
      const { service } = makeService()
      await expect(service.findPharmacy('B2')).resolves.toMatchObject({ pharmacyCode: 'B2' })
      await expect(service.findPharmacy('b2')).resolves.toBeNull()
    })

    it('surfaces an upstream outage as 503', async () => {
      const { service } = makeService({ fetch: jest.fn().mockResolvedValue(response(500, {})) })
      await expect(service.listStates()).rejects.toBeInstanceOf(ServiceUnavailableException)
    })
  })

  describe('drugs', () => {
    const drugs = [
      { drugName: 'EMZOR PARACETAMOL X 96', genericName: 'PARACETAMOL', packSize: 96, drugPrice: 1824, unitPrice: 19 },
      { drugName: 'EMZOR PARACETAMOL SYRUP 60ML', genericName: 'PARACETAMOL', packSize: 1, drugPrice: 912, unitPrice: 912 },
    ]
    const searchFetch = () => jest.fn().mockResolvedValue(response(200, { data: drugs }))

    it('maps search results, pricing per pack (drugPrice), not per tablet', async () => {
      const { service, fetch } = makeService({ fetch: searchFetch() })
      const results = await service.searchDrugs('  paracetamol ')
      expect(fetch.mock.calls[0][0]).toMatch(/\/healthcare\/drugs\/search\?query=paracetamol$/)
      expect(results[0]).toMatchObject({ drugName: 'EMZOR PARACETAMOL X 96', price: 1824, currency: 'NGN', packSize: 96 })
    })

    it('rejects queries shorter than the provider minimum without calling it', async () => {
      const { service, fetch } = makeService({ fetch: searchFetch() })
      await expect(service.searchDrugs('par')).rejects.toBeInstanceOf(BadRequestException)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('resolves lines to live pack prices by exact name', async () => {
      const { service } = makeService({ fetch: searchFetch() })
      await expect(
        service.resolveDrugLines([{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, dose: 'x' }]),
      ).resolves.toEqual([{ drugName: 'EMZOR PARACETAMOL SYRUP 60ML', quantity: 2, dose: 'x', unitPrice: 912 }])
    })

    it('refuses a medication that is not listed', async () => {
      const { service } = makeService({ fetch: searchFetch() })
      await expect(service.resolveDrugLines([{ drugName: 'EMZOR PARACETAMOL', quantity: 1 }])).rejects.toBeInstanceOf(
        NotFoundException,
      )
    })
  })

  describe('getProductFxRate', () => {
    it('derives NGN per USD from the product, like the other buhibab products', async () => {
      const { service } = makeService()
      await expect(service.getProductFxRate(1951)).resolves.toBeCloseTo(100 / 0.07)
    })

    it('503s when the pharmacy product is missing', async () => {
      const { service } = makeService({ products: { message: 'ok', data: [] } })
      await expect(service.getProductFxRate(1951)).rejects.toBeInstanceOf(ServiceUnavailableException)
    })
  })
})
