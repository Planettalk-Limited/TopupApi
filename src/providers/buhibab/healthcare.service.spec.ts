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
