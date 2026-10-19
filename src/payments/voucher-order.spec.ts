import { extractVoucherCode, validateVoucherOrder, voucherProductName } from './voucher-order'
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

describe('extractVoucherCode', () => {
  it('finds a code in data.meta first', () => {
    expect(extractVoucherCode({ id: 9, meta: { voucher_code: 'ABC-123', pin: '4321' } })).toEqual({
      cardCode: 'ABC-123',
      cardPin: '4321',
    })
  })

  it('falls back to the data object', () => {
    expect(extractVoucherCode({ id: 9, code: 'XYZ' })).toEqual({ cardCode: 'XYZ' })
  })

  it('returns null when the voucher is only emailed', () => {
    expect(extractVoucherCode({ id: 9, status: 'completed', meta: null })).toBeNull()
    expect(extractVoucherCode(undefined)).toBeNull()
  })
})
