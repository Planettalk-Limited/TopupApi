import { extractIssuedVouchers, validateVoucherOrder, voucherProductName } from './voucher-order'
import type { VoucherFulfillmentOrder } from './payments.types'

function order(over: Partial<VoucherFulfillmentOrder> = {}): VoucherFulfillmentOrder {
  return {
    productType: 'voucher',
    countryCode: 'NG',
    providerAmount: 5000,
    providerCurrency: 'NGN',
    email: 'buyer@example.com',
    productId: 1957,
    ...over,
  }
}

describe('validateVoucherOrder', () => {
  it('accepts a well-formed order', () => {
    expect(validateVoucherOrder(order())).toBeNull()
    expect(validateVoucherOrder(order({ recipientEmail: 'mum@example.com' }))).toBeNull()
  })

  it.each([
    [{ countryCode: 'GH' }, /Nigeria/],
    [{ providerCurrency: 'USD' }, /NGN/],
    [{ email: 'nope' }, /email/],
    [{ recipientEmail: 'nope' }, /Recipient email/],
    [{ providerAmount: 5000.5 }, /whole number/],
  ])('rejects %j', (over, message) => {
    expect(validateVoucherOrder(order(over as Partial<VoucherFulfillmentOrder>))).toMatch(message)
  })
})

describe('voucherProductName', () => {
  it('names the brand', () => {
    expect(voucherProductName(' SPAR ')).toBe('SPAR gift voucher')
  })
})

describe('extractIssuedVouchers', () => {
  it('reads data.meta.vouchers, as buhibab returned it on the first live order', () => {
    const data = {
      id: 1,
      status: 'completed',
      meta: {
        vouchers: [{ pin: '7545', code: '321154121525', value: 10000, serial: 301126367, expiry_date: '2027-10-22T11:48:04.5472111Z' }],
        order_number: '453988',
      },
    }
    expect(extractIssuedVouchers(data)).toEqual([
      { code: '321154121525', pin: '7545', serial: '301126367', expiresAt: '2027-10-22T11:48:04.5472111Z', value: 10000 },
    ])
  })

  it('keeps every voucher, and drops entries with no code', () => {
    const data = { meta: { vouchers: [{ code: 'A' }, { pin: '1' }, { code: ' ' }, { code: 'B', pin: 2 }] } }
    expect(extractIssuedVouchers(data)).toEqual([{ code: 'A' }, { code: 'B', pin: '2' }])
  })

  it('returns nothing when no vouchers came back', () => {
    expect(extractIssuedVouchers({ id: 9, status: 'completed', meta: null })).toEqual([])
    expect(extractIssuedVouchers({ meta: { order_number: '1' } })).toEqual([])
    expect(extractIssuedVouchers(undefined)).toEqual([])
  })
})
