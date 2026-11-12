import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common'
import { GiftVoucherIssuerService } from './gift-voucher-issuer.service'
import { readGiftCampaignConfig } from './gift-campaign.config'

const admin = { id: 'admin-1', email: 'a@x', name: 'A', role: 'SUPERADMIN' as const }
const CONFIG = readGiftCampaignConfig({
  GIFT_CAMPAIGN_ENABLED: 'true',
  GIFT_CAMPAIGN_VOUCHER_PRODUCT_ID: '77',
  GIFT_CAMPAIGN_VOUCHER_AMOUNT_NGN: '20000',
  GIFT_CAMPAIGN_FULFILMENT_EMAIL: 'gifts@planettalk.example',
})

const submission = (over: Record<string, unknown> = {}) => ({
  id: 'sub-1',
  reference: 'GFT-ABC',
  status: 'APPROVED',
  voucherOrderId: null,
  recipientPhone: '+2348031234567',
  recipientEmail: 'chi@example.ng',
  ...over,
})

function setup(sub: unknown = submission(), linkCount = 1) {
  const tx = {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-v1' }) },
    giftCampaignSubmission: { updateMany: jest.fn().mockResolvedValue({ count: linkCount }) },
  }
  const prisma = {
    giftCampaignSubmission: { findUnique: jest.fn().mockResolvedValue(sub), update: jest.fn().mockResolvedValue({}) },
    giftCampaignEvent: { count: jest.fn().mockResolvedValue(0), createMany: jest.fn().mockResolvedValue({}) },
    fulfillment: { update: jest.fn().mockResolvedValue({}) },
    order: { update: jest.fn().mockResolvedValue({}) },
    providerCallLog: { create: jest.fn().mockResolvedValue({}) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const executor = {
    execute: jest.fn().mockResolvedValue({
      transaction: { transactionId: '9', referenceId: 'BUH-REF', meta: {}, timestamp: '', provider: 'planettalk' },
      giftCard: { cardCode: 'CODE', cardPin: '1234' },
      vouchers: [{ code: 'CODE', pin: '1234', value: 20000 }],
    }),
  }
  const vouchers = { findVoucher: jest.fn().mockResolvedValue({ id: 77, name: 'SPAR', minAmount: 1000, maxAmount: 100000 }) }
  const alert = { notify: jest.fn().mockResolvedValue(undefined) }
  const email = { sendVoucherDelivery: jest.fn().mockResolvedValue(true) }
  const entitlements = { config: () => CONFIG }
  const svc = new GiftVoucherIssuerService(
    prisma as never,
    executor as never,
    vouchers as never,
    alert as never,
    email as never,
    entitlements as never,
  )
  return { svc, prisma, tx, executor, alert, email }
}

describe('GiftVoucherIssuerService', () => {
  it('creates an unpaid, already-claimed voucher order and issues it without Stripe', async () => {
    const { svc, tx, executor, prisma, email } = setup()
    const res = await svc.issue('sub-1', admin)
    expect(res).toMatchObject({ status: 'AWAITING_REDEMPTION', voucherReference: 'BUH-REF', emailedToRecipient: true })

    const order = tx.order.create.mock.calls[0][0].data
    expect(order).toMatchObject({
      paymentIntentId: 'giftcampaign_sub-1_1',
      productType: 'VOUCHER',
      chargeAmount: 0,
      providerAmount: 20000,
      status: 'PAID',
      fulfillment: { create: expect.objectContaining({ status: 'PROCESSING' }) },
    })
    expect(executor.execute).toHaveBeenCalledWith(
      expect.objectContaining({ productType: 'voucher', productId: 77, providerAmount: 20000, recipientEmail: 'chi@example.ng' }),
      'giftcampaign_sub-1_1',
      'order-v1',
    )
    expect(prisma.giftCampaignSubmission.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'AWAITING_REDEMPTION' }) }),
    )
    expect(email.sendVoucherDelivery).toHaveBeenCalledWith(expect.objectContaining({ to: 'chi@example.ng' }))
    // The code/PIN never go into the audit trail.
    expect(JSON.stringify(prisma.giftCampaignEvent.createMany.mock.calls)).not.toMatch(/CODE|1234/)
  })

  it('uses the fulfilment email for buhibab when the recipient gave none, and emails no one', async () => {
    const { svc, executor, email } = setup(submission({ recipientEmail: null }))
    const res = await svc.issue('sub-1', admin)
    expect(executor.execute.mock.calls[0][0].email).toBe('gifts@planettalk.example')
    expect(email.sendVoucherDelivery).not.toHaveBeenCalled()
    expect(res.emailedToRecipient).toBeNull()
  })

  it('refuses an unapproved submission', async () => {
    const { svc, executor } = setup(submission({ status: 'PENDING_VALIDATION' }))
    await expect(svc.issue('sub-1', admin)).rejects.toBeInstanceOf(ConflictException)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('refuses to issue twice', async () => {
    const { svc } = setup(submission({ voucherOrderId: 'order-old' }))
    await expect(svc.issue('sub-1', admin)).rejects.toBeInstanceOf(ConflictException)
  })

  it('refuses when a concurrent issue won the guarded link', async () => {
    const { svc, executor } = setup(submission(), 0)
    await expect(svc.issue('sub-1', admin)).rejects.toBeInstanceOf(ConflictException)
    expect(executor.execute).not.toHaveBeenCalled()
  })

  it('refuses an amount outside the brand range', async () => {
    const { svc } = setup()
    await expect(svc.issue('sub-1', admin, { amountNgn: 500 })).rejects.toBeInstanceOf(BadRequestException)
  })

  it('on a definite refusal: escalates, unlinks for a later retry, never marks fulfilled', async () => {
    const { svc, executor, prisma, alert } = setup()
    executor.execute.mockRejectedValue(Object.assign(new Error('Out of stock'), { retryable: false }))
    await expect(svc.issue('sub-1', admin)).rejects.toBeInstanceOf(ServiceUnavailableException)
    expect(prisma.giftCampaignSubmission.update).toHaveBeenCalledWith({
      where: { id: 'sub-1' },
      data: expect.objectContaining({ status: 'ESCALATED', reasonCode: 'VOUCHER_ISSUE_FAILED', voucherOrderId: null }),
    })
    expect(prisma.order.update).toHaveBeenCalledWith({ where: { id: 'order-v1' }, data: { status: 'FAILED' } })
    expect(alert.notify).toHaveBeenCalled()
  })

  it('on an unknown outcome: keeps the order linked so nobody buys it twice', async () => {
    const { svc, executor, prisma } = setup()
    executor.execute.mockRejectedValue(Object.assign(new Error('timeout'), { exhaustAttempts: true }))
    await expect(svc.issue('sub-1', admin)).rejects.toBeInstanceOf(ServiceUnavailableException)
    const data = prisma.giftCampaignSubmission.update.mock.calls[0][0].data
    expect(data.status).toBe('ESCALATED')
    expect('voucherOrderId' in data).toBe(false)
  })
})
