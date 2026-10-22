import { MARKUP, PricingError, PricingService } from './pricing.service'
import { convertCurrency } from './static-fx'

const SPAR = { id: 1957, name: 'SPAR', minAmount: 500, maxAmount: 100_000, fxRate: 500 / 0.33 }

function build(voucher: typeof SPAR | null = SPAR) {
  const vouchers = { findVoucher: jest.fn().mockResolvedValue(voucher) }
  return { pricing: new PricingService({} as any, {} as any, {} as any, vouchers as any), vouchers }
}

describe('PricingService — vouchers', () => {
  it('charges the USD cost (amount / fx) with markup, in the charge currency', async () => {
    const { pricing } = build()
    const charge = await pricing.chargeForVoucher(1957, 5000, 'gbp')
    const expected = Math.round(convertCurrency((5000 / SPAR.fxRate) * MARKUP, 'USD', 'gbp') * 100) / 100
    expect(charge).toBeCloseTo(expected, 2)
  })

  it('is not bound by the global £3–£20 band', async () => {
    const { pricing } = build()
    // NGN 500 is ~£0.25 — below the band, but a valid voucher.
    await expect(
      pricing.priceOrder(
        { productType: 'voucher', countryCode: 'NG', providerAmount: 500, providerCurrency: 'NGN', productId: 1957, email: 'a@b.co' },
        'gbp',
      ),
    ).resolves.toBeGreaterThan(0)
  })

  it.each([
    [499, /between/],
    [100_001, /between/],
    [5000.5, /whole number/],
  ])('rejects NGN %s', async (amount, message) => {
    const { pricing } = build()
    await expect(pricing.chargeForVoucher(1957, amount, 'gbp')).rejects.toThrow(message)
  })

  it('rejects a brand that is no longer listed', async () => {
    const { pricing } = build(null)
    await expect(pricing.chargeForVoucher(1957, 5000, 'gbp')).rejects.toBeInstanceOf(PricingError)
  })
})
