import { BadRequestException, Logger, NotFoundException, ServiceUnavailableException } from '@nestjs/common'
import { describeKeyShape, extractCustomerName, PlanetTalkService } from './planettalk.service'
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

describe('extractCustomerName', () => {
  it.each([
    ['root customerName', { customerName: 'ADA OBI' }],
    ['data.customer_name', { data: { customer_name: 'ADA OBI' } }],
    ['content.Customer_Name', { content: { Customer_Name: 'ADA OBI' } }],
    ['nested details', { status: true, data: { details: { customer_name: 'ADA OBI' } } }],
    ['customer.name', { data: { customer: { name: 'ADA OBI' } } }],
    ['accountName', { data: { accountName: ' ADA OBI ' } }],
    ['account_name in an array', { data: { result: [{ account_name: 'ADA OBI' }] } }],
    ['Account.Holder name', { response: { account: { holder: { name: 'ADA OBI' } } } }],
    ['customer first/last name', { data: { customer: { first_name: 'ADA', last_name: 'OBI' } } }],
  ])('finds the name: %s', (_label, body) => {
    expect(extractCustomerName(body)).toBe('ADA OBI')
  })

  it('prefers an explicit customer-name key over a bare name elsewhere', () => {
    expect(extractCustomerName({ name: 'Verify meter', data: { info: { customerName: 'ADA OBI' } } })).toBe('ADA OBI')
  })

  it('never returns a product / biller / operator name', () => {
    expect(extractCustomerName({ data: { product: { name: 'Ikeja Electric Payment - IKEDC' } } })).toBeNull()
    expect(extractCustomerName({ data: { biller: { name: 'IKEDC' }, service: { name: 'Prepaid' } } })).toBeNull()
    expect(
      extractCustomerName({ data: { product: { name: 'IKEDC' }, customer: { name: 'ADA OBI' } } }),
    ).toBe('ADA OBI')
  })

  it('ignores empty, non-string and numeric-only values', () => {
    expect(extractCustomerName({ data: { customerName: '   ', accountName: 42, customer_name: '04223568280' } })).toBeNull()
  })

  it('stops at a bounded depth', () => {
    let deep: Record<string, unknown> = { customerName: 'ADA OBI' }
    for (let i = 0; i < 12; i++) deep = { nested: deep }
    expect(extractCustomerName(deep)).toBeNull()
  })

  it('returns null for non-objects', () => {
    expect(extractCustomerName(null)).toBeNull()
    expect(extractCustomerName('ADA')).toBeNull()
  })
})

describe('describeKeyShape', () => {
  it('lists keys only, never values', () => {
    const shape = describeKeyShape({
      message: 'OK',
      data: { meter: '04223568280', owner_info: { line1: 'ADA OBI' }, items: [{ units: 3 }] },
    })
    expect(shape).toBe('{data:{items:[{units}],meter,owner_info:{line1}},message}')
    expect(shape).not.toContain('04223568280')
    expect(shape).not.toContain('ADA')
  })
})

describe('PlanetTalkService.verifyAccount — missing name diagnostics', () => {
  it('logs the response key shape (no values) when verification succeeds without a name', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ message: 'OK', data: { meter: '04223568280', owner: { line1: 'ADA OBI' } } }),
    })
    const svc = mockService({ fetch })

    const result = await svc.verifyAccount({ productId: 994, billersCode: '04223568280' })

    expect(result).toEqual({ valid: true, customerName: null })
    const logged = warn.mock.calls.map((c) => String(c[0])).join('\n')
    expect(logged).toContain('{data:{meter,owner:{line1}},message}')
    expect(logged).not.toContain('04223568280')
    expect(logged).not.toContain('ADA OBI')
    warn.mockRestore()
  })

  it('does not log when a name was found', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined)
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: { details: { customer_name: 'ADA OBI' } } }),
    })
    const result = await mockService({ fetch }).verifyAccount({ productId: 994, billersCode: '1' })

    expect(result).toEqual({ valid: true, customerName: 'ADA OBI' })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})
