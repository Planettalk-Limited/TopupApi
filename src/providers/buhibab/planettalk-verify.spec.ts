import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'
import type { MappedBiller } from './planettalk.mappers'

function makeBiller(overrides: Partial<MappedBiller> = {}): MappedBiller {
  return {
    id: 994,
    name: 'Ikeja Electric Payment - IKEDC',
    type: 'ELECTRICITY',
    serviceType: 'Prepaid',
    countryCode: 'NG',
    localAmountSupported: true,
    internationalAmountSupported: false,
    localTransactionCurrencyCode: 'NGN',
    senderCurrencyCode: 'USD',
    fx: { rate: 1550, currencyCode: 'NGN' },
    logoUrls: [],
    minLocalTransactionAmount: 1000,
    maxLocalTransactionAmount: 100000,
    localMinAmount: 1000,
    localMaxAmount: 100000,
    minAmount: 0.6,
    maxAmount: 64,
    localFixedAmounts: [],
    localFixedAmountsDescriptions: {},
    _requiresPhone: true,
    _additionalFields: [],
    _fixedPrice: false,
    _accountLabel: 'Meter Number',
    _accountPlaceholder: 'Enter meter',
    _phoneLabel: 'Phone',
    ...overrides,
  }
}

function mockService(opts: {
  billers?: MappedBiller[]
  fetch?: jest.Mock
  hasCredentials?: boolean
}) {
  const svc = Object.create(PlanetTalkService.prototype) as PlanetTalkService
  ;(svc as any).hasCredentials = () => opts.hasCredentials !== false
  ;(svc as any).fetchAndBuildBillers = jest.fn().mockResolvedValue(opts.billers ?? [makeBiller()])
  ;(svc as any).fetch = opts.fetch ?? jest.fn()
  return svc
}

describe('PlanetTalkService.verifyAccount', () => {
  it('rejects when credentials are missing', async () => {
    const svc = mockService({ hasCredentials: false })
    await expect(
      svc.verifyAccount({ productId: 994, billersCode: '12345678901' }),
    ).rejects.toBeInstanceOf(ServiceUnavailableException)
  })

  it('rejects unknown product ids', async () => {
    const svc = mockService({ billers: [makeBiller()] })
    await expect(
      svc.verifyAccount({ productId: 99999, billersCode: '12345678901' }),
    ).rejects.toBeInstanceOf(NotFoundException)
  })

  it('rejects Internet (and other non-electricity/TV) billers', async () => {
    const svc = mockService({
      billers: [makeBiller({ id: 71, type: 'INTERNET', name: 'Smile' })],
    })
    await expect(
      svc.verifyAccount({ productId: 71, billersCode: '1212121212' }),
    ).rejects.toBeInstanceOf(BadRequestException)
  })

  it('POSTs verify-meter for ELECTRICITY and returns customerName on success', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'OK', data: { customer_name: 'ADA OBI' } }),
    })
    const svc = mockService({ fetch })

    const result = await svc.verifyAccount({
      productId: 994,
      billersCode: '04223568280',
      meterType: 'prepaid',
    })

    expect(result).toEqual({ valid: true, customerName: 'ADA OBI' })
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0]
    expect(url).toMatch(/\/products\/994\/verify-meter$/)
    expect(init.method).toBe('POST')
    const body = init.body as FormData
    expect(body.get('billersCode')).toBe('04223568280')
    expect(body.get('type')).toBe('prepaid')
  })

  it('POSTs verify-smartcard for TV without a type field', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { Customer_Name: 'CHIDI OKA' } }),
    })
    const svc = mockService({
      billers: [makeBiller({ id: 1726, type: 'TV', name: 'DStv Yanga' })],
      fetch,
    })

    const result = await svc.verifyAccount({ productId: 1726, billersCode: '8223140944' })

    expect(result).toEqual({ valid: true, customerName: 'CHIDI OKA' })
    const [url, init] = fetch.mock.calls[0]
    expect(url).toMatch(/\/products\/1726\/verify-smartcard$/)
    const body = init.body as FormData
    expect(body.get('billersCode')).toBe('8223140944')
    expect(body.get('type')).toBeNull()
  })

  it('maps Buhibab 422 into valid:false with the provider message', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 422,
      json: async () => ({
        message: 'This meter is not correct or is not a valid Ikeja Electric prepaid meter. Please check and try again',
      }),
    })
    const svc = mockService({ fetch })

    const result = await svc.verifyAccount({ productId: 994, billersCode: '000' })

    expect(result).toEqual({
      valid: false,
      message:
        'This meter is not correct or is not a valid Ikeja Electric prepaid meter. Please check and try again',
    })
  })

  it('treats Reloadly-style ELECTRICITY_BILL_PAYMENT type as meter verify', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ content: { Customer_Name: 'TEST USER' } }),
    })
    const svc = mockService({
      billers: [makeBiller({ type: 'ELECTRICITY_BILL_PAYMENT' })],
      fetch,
    })

    const result = await svc.verifyAccount({ productId: 994, billersCode: '123' })
    expect(result.valid).toBe(true)
    expect(fetch.mock.calls[0][0]).toMatch(/verify-meter$/)
  })
})
