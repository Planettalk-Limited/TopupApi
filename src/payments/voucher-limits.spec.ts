import { assertVoucherDailyLimit, VOUCHER_DAILY_MAX_NGN, VoucherLimitError } from './voucher-limits'

function prismaWithSpent(spent: number | null) {
  return { order: { aggregate: jest.fn().mockResolvedValue({ _sum: { providerAmount: spent } }) } }
}

describe('assertVoucherDailyLimit', () => {
  const now = new Date('2026-10-22T12:00:00Z')

  it('defaults to NGN 100,000 a day', () => {
    expect(VOUCHER_DAILY_MAX_NGN).toBe(100_000)
  })

  it('allows a purchase that keeps the buyer within the cap', async () => {
    const prisma = prismaWithSpent(60_000)
    await expect(
      assertVoucherDailyLimit(prisma, { amountNgn: 40_000, buyerEmail: 'A@Example.com ', now }),
    ).resolves.toBeUndefined()
  })

  it('refuses one that would pass it, saying how much is left', async () => {
    const prisma = prismaWithSpent(60_000)
    const attempt = assertVoucherDailyLimit(prisma, { amountNgn: 50_000, buyerEmail: 'a@example.com', now })
    await expect(attempt).rejects.toBeInstanceOf(VoucherLimitError)
    await expect(attempt).rejects.toThrow('NGN 40,000 more today')
  })

  it('says to come back tomorrow once the cap is used up', async () => {
    await expect(
      assertVoucherDailyLimit(prismaWithSpent(100_000), { amountNgn: 10_000, buyerEmail: 'a@example.com', now }),
    ).rejects.toThrow('try again tomorrow')
  })

  it('counts paid and delivered vouchers over the last 24 hours, by email or card, excluding this order', async () => {
    const prisma = prismaWithSpent(null)
    await assertVoucherDailyLimit(prisma, {
      amountNgn: 10_000,
      buyerEmail: ' A@Example.com',
      cardFingerprint: 'fp_123',
      excludePaymentIntentId: 'pi_1',
      now,
    })

    expect(prisma.order.aggregate).toHaveBeenCalledWith({
      where: {
        productType: 'VOUCHER',
        status: { in: ['PAID', 'FULFILLED'] },
        createdAt: { gte: new Date('2026-10-21T12:00:00Z') },
        OR: [{ buyerEmail: 'a@example.com' }, { cardFingerprint: 'fp_123' }],
        NOT: { paymentIntentId: 'pi_1' },
      },
      _sum: { providerAmount: true },
    })
  })

  it('checks nothing when there is no email or card to key on', async () => {
    const prisma = prismaWithSpent(999_999)
    await expect(assertVoucherDailyLimit(prisma, { amountNgn: 10_000, now })).resolves.toBeUndefined()
    expect(prisma.order.aggregate).not.toHaveBeenCalled()
  })
})
