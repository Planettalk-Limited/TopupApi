import { VOUCHER_MAX_NGN, VoucherService, voucherCategory } from './voucher.service'

function product(over: Record<string, unknown> = {}) {
  return {
    id: 1957,
    name: 'SPAR',
    operator_name: 'SureGifts',
    operator_logo: null,
    value_amount: 500,
    price: 0.33,
    value_amount_max: null,
    price_max: null,
    fixed_price: false,
    destination_country: { id: 160, sortname: 'NG', name: 'Nigeria', currency_code: 'NGN', currency_symbol: '₦' },
    additional_fields: [],
    ...over,
  }
}

function service(products: Record<string, unknown>[]) {
  const planetTalk = {
    fetchRawProducts: jest.fn().mockResolvedValue({
      message: 'ok',
      data: [{ sub_service: { id: 7, app_service_id: 4, name: 'Gift Vouchers' }, products }],
    }),
  }
  return { svc: new VoucherService(planetTalk as any), planetTalk }
}

describe('voucherCategory', () => {
  it.each([
    'SPAR',
    'Justrite',
    'Prince Ebeano Supermarket',
    'Jendol Superstores',
    'Alpha Prime Grocery Stores',
    'QUICK GRAB MART',
    'Gara-Mart Limited',
    'Chichi Foodstuff',
    'Eden Whole Foods',
    'PricePally',
  ])('%s is groceries', (name) => {
    expect(voucherCategory(name)).toBe('groceries')
  })

  it.each(['Filmhouse Cinemas', 'Konga', 'Somotex Nigeria Limited (Electromart)', 'HealthPlus', 'Samsung', 'iStore'])(
    '%s is a gift voucher',
    (name) => {
      expect(voucherCategory(name)).toBe('gift')
    },
  )
})

describe('voucherCategory with provider tags', () => {
  it('uses the Groceries tag over the name', () => {
    expect(voucherCategory('Onigbinde Stores', ['Groceries'])).toBe('groceries')
    expect(voucherCategory('Super Saver Supermarket', ['Food'])).toBe('gift')
  })

  it('keeps catch-all vouchers tagged with everything out of groceries', () => {
    const all = ['Adventure & Experiences', 'Beauty & Wellness', 'Books', 'Electronics', 'Food', 'Groceries', 'Luxury']
    expect(voucherCategory('Suregifts Generic', all)).toBe('gift')
  })
})

describe('VoucherService', () => {
  it('reads only the Gift Vouchers sub-service and maps bounds, category and fx', async () => {
    const { svc, planetTalk } = service([product()])
    const [v] = await svc.listVouchers()
    expect(planetTalk.fetchRawProducts).toHaveBeenCalledWith('Gift Vouchers')
    expect(v).toEqual({
      id: 1957,
      name: 'SPAR',
      category: 'groceries',
      tags: [],
      supplier: 'SureGifts',
      logo: null,
      minAmount: 500,
      maxAmount: VOUCHER_MAX_NGN,
      currency: 'NGN',
      fxRate: 500 / 0.33,
    })
  })

  it('uses the product image as the logo, never the operator logo', async () => {
    const { svc } = service([
      product({ id: 1, image_url: 'https://cdn.example/spar.png', operator_logo: 'https://cdn.example/suregifts.png' }),
      product({ id: 2, image_url: '  ', operator_logo: 'https://cdn.example/suregifts.png' }),
      product({ id: 3, image_url: null }),
    ])
    expect((await svc.listVouchers()).map((v) => v.logo)).toEqual(['https://cdn.example/spar.png', null, null])
  })

  it('filters by category', async () => {
    const { svc } = service([product(), product({ id: 1981, name: 'Filmhouse Cinemas' })])
    expect((await svc.listVouchers('gift')).map((v) => v.id)).toEqual([1981])
    expect((await svc.listVouchers('groceries')).map((v) => v.id)).toEqual([1957])
  })

  it('honours an upstream maximum below our cap, and drops brands it cannot sell', async () => {
    const { svc } = service([
      product({ id: 1, value_amount_max: 20_000 }),
      product({ id: 2, value_amount: VOUCHER_MAX_NGN + 1 }),
      product({ id: 3, price: 0 }),
    ])
    const vouchers = await svc.listVouchers()
    expect(vouchers.map((v) => v.id)).toEqual([1])
    expect(vouchers[0].maxAmount).toBe(20_000)
  })
})
