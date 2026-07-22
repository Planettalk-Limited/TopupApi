import { convertCurrency, toStripeAmount, validateStripeAmount, getStripeLimits } from './static-fx'

describe('static-fx', () => {
  it('convertCurrency uses the static table (USD base), same-currency is identity', () => {
    expect(convertCurrency(10, 'USD', 'USD')).toBe(10)
    // GBP rate 0.79, USD rate 1 => 10 USD -> 7.9 GBP
    expect(convertCurrency(10, 'USD', 'GBP')).toBeCloseTo(7.9, 5)
    // NGN 1550 per USD => 1550 NGN -> 1 USD
    expect(convertCurrency(1550, 'NGN', 'USD')).toBeCloseTo(1, 5)
  })
  it('getStripeLimits knows GBP 2-decimals and JPY 0-decimals', () => {
    expect(getStripeLimits('GBP').decimals).toBe(2)
    expect(getStripeLimits('JPY').decimals).toBe(0)
  })
  it('toStripeAmount converts to smallest unit', () => {
    expect(toStripeAmount(7.9, 'GBP')).toBe(790)
    expect(toStripeAmount(500, 'JPY')).toBe(500)
  })
  it('validateStripeAmount rejects below minimum', () => {
    expect(validateStripeAmount(0.1, 'GBP').valid).toBe(false)
    expect(validateStripeAmount(5, 'GBP').valid).toBe(true)
  })
})
