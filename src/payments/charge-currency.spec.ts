import { BadRequestException } from '@nestjs/common'
import { CHARGE_CURRENCIES, resolveChargeCurrency } from './charge-currency'

describe('resolveChargeCurrency', () => {
  it('accepts each supported currency case-insensitively, returning lowercase', () => {
    for (const c of CHARGE_CURRENCIES) {
      expect(resolveChargeCurrency(c)).toBe(c)
      expect(resolveChargeCurrency(c.toUpperCase())).toBe(c)
    }
  })

  it('defaults to USD when no currency is supplied', () => {
    expect(resolveChargeCurrency(undefined)).toBe('usd')
    expect(resolveChargeCurrency('')).toBe('usd')
  })

  it.each(['ngn', 'KES', 'aud', 'chf', 'xyz'])('rejects %s with a 400', (c) => {
    expect(() => resolveChargeCurrency(c)).toThrow(BadRequestException)
  })
})
