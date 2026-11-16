import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { HealthcareService } from './healthcare.service'

const response = (status: number, body: unknown) => ({ status, ok: status < 400, json: async () => body })

function makeService(opts: { fetch?: jest.Mock; products?: unknown } = {}) {
  const fetch = opts.fetch ?? jest.fn()
  const planetTalk = {
    fetch,
    fetchRawProducts: jest.fn().mockResolvedValue(
      opts.products ?? {
        message: 'ok',
        data: [{ sub_service: { name: 'Pharmacy' }, products: [{ id: 1951, value_amount: 100, price: 0.07 }] }],
      },
    ),
  } as any
  return { service: new HealthcareService(planetTalk), fetch, planetTalk }
}

describe('HealthcareService', () => {
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

    it('drops repeated records (buhibab returns each drug twice), keeping the first', async () => {
      const { service } = makeService({
        fetch: jest.fn().mockResolvedValue(response(200, { data: [drugs[0], drugs[1], drugs[0], { ...drugs[1], drugPrice: 999 }] })),
      })
      const results = await service.searchDrugs('paracetamol')
      expect(results.map((d) => [d.drugName, d.price])).toEqual([
        ['EMZOR PARACETAMOL X 96', 1824],
        ['EMZOR PARACETAMOL SYRUP 60ML', 912],
      ])
    })

    it('blanks template placeholders such as strength "Strength"', async () => {
      const raw = {
        drugName: 'PARACETAMOL TABLET 1g X10',
        genericName: 'GenericName',
        brandName: 'BrandName',
        drugClass: 'DrugClass',
        dosageForm: 'DosageForm',
        strength: 'Strength',
        packSize: 10,
        drugPrice: 492.5,
      }
      const { service } = makeService({ fetch: jest.fn().mockResolvedValue(response(200, { data: [raw] })) })
      const [drug] = await service.searchDrugs('paracetamol')
      expect(drug).toMatchObject({
        genericName: null,
        brandName: null,
        drugClass: null,
        dosageForm: null,
        strength: null,
        packSize: 10,
      })
    })

    it('rejects queries shorter than the provider minimum without calling it', async () => {
      const { service, fetch } = makeService({ fetch: searchFetch() })
      await expect(service.searchDrugs('par')).rejects.toBeInstanceOf(BadRequestException)
      expect(fetch).not.toHaveBeenCalled()
    })

    it('surfaces an upstream outage as 503', async () => {
      const { service } = makeService({ fetch: jest.fn().mockResolvedValue(response(500, {})) })
      await expect(service.searchDrugs('paracetamol')).rejects.toBeInstanceOf(ServiceUnavailableException)
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

  describe('pharmacy product', () => {
    const products = (...groups: Array<[string, Array<Record<string, unknown>>]>) => ({
      message: 'ok',
      data: groups.map(([name, items]) => ({ sub_service: { name }, products: items })),
    })
    const purchase = { id: 3353, name: 'WellaHealth Pharmacy Purchase', value_amount: 100, price: 0.08 }

    it('finds the product by its "Pharmacy" sub-service, not a fixed id', async () => {
      const { service, planetTalk } = makeService({ products: products(['Pharmacy', [purchase]]) })
      await expect(service.getPharmacyProduct()).resolves.toEqual({ id: 3353, fxRate: 100 / 0.08 })
      expect(planetTalk.fetchRawProducts).toHaveBeenCalledWith('Pharmacy')
    })

    it('prefers the purchase product by name if the sub-service gains others', async () => {
      const other = { id: 9, name: 'Something Else', value_amount: 100, price: 0.1 }
      const { service } = makeService({ products: products(['Pharmacy', [other, purchase]]) })
      await expect(service.getPharmacyProduct()).resolves.toMatchObject({ id: 3353 })
    })

    it('refuses to guess between several unnamed candidates', async () => {
      const a = { id: 1, name: 'A', value_amount: 100, price: 0.1 }
      const b = { id: 2, name: 'B', value_amount: 100, price: 0.1 }
      const { service } = makeService({ products: products(['Pharmacy', [a, b]]) })
      await expect(service.getPharmacyProduct()).rejects.toBeInstanceOf(ServiceUnavailableException)
    })

    it('503s when the pharmacy product is missing or unpriced', async () => {
      const { service } = makeService({ products: products(['Pharmacy', [{ ...purchase, price: 0 }]]) })
      await expect(service.getPharmacyProduct()).rejects.toBeInstanceOf(ServiceUnavailableException)
      const { service: empty } = makeService({ products: products() })
      await expect(empty.getProductFxRate()).rejects.toBeInstanceOf(ServiceUnavailableException)
    })

    it('derives NGN per USD from the live product, like the other buhibab products', async () => {
      const { service } = makeService({ products: products(['Pharmacy', [purchase]]) })
      await expect(service.getProductFxRate()).resolves.toBeCloseTo(100 / 0.08)
      await expect(service.getProductFxRate(3353)).resolves.toBeCloseTo(100 / 0.08)
    })

    it('refuses to price an order bound to a product that is no longer the pharmacy product', async () => {
      const { service } = makeService({ products: products(['Pharmacy', [purchase]]) })
      await expect(service.getProductFxRate(1951)).rejects.toBeInstanceOf(ServiceUnavailableException)
    })
  })
})
