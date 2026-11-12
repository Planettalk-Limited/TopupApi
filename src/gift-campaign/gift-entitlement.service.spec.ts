import { GiftEntitlementService } from './gift-entitlement.service'
import { deriveLinkToken, hashLinkToken } from './gift-token'

const ENV_KEYS = ['GIFT_CAMPAIGN_ENABLED', 'GIFT_CAMPAIGN_TOKEN_SECRET', 'JWT_SECRET', 'PUBLIC_SITE_URL', 'GIFT_CAMPAIGN_MAX_PER_CUSTOMER']
const saved: Record<string, string | undefined> = {}

const fulfilledOrder = (over: Record<string, unknown> = {}) => ({
  id: 'order-1',
  status: 'FULFILLED',
  refunded: false,
  disputed: false,
  customerId: 'cust-1',
  productType: 'TOPUP',
  countryCode: 'NG',
  chargeAmount: 20,
  chargeCurrency: 'GBP',
  paymentIntentId: 'pi_1',
  createdAt: new Date(),
  customer: { id: 'cust-1', email: 'ada@example.com', firstName: 'Ada', phone: '+447400123456' },
  ...over,
})

function setup(order: unknown = fulfilledOrder(), existing = 0) {
  const tx = {
    $executeRaw: jest.fn().mockResolvedValue(1),
    giftCampaignEntitlement: {
      count: jest.fn().mockResolvedValue(existing),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'ent-1', ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    order: { findUnique: jest.fn().mockResolvedValue(order) },
    giftCampaignEntitlement: { update: jest.fn().mockResolvedValue({}) },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const email = { sendGiftCampaignEmail: jest.fn().mockResolvedValue(true) }
  return { svc: new GiftEntitlementService(prisma as never, email as never), prisma, tx, email }
}

describe('GiftEntitlementService', () => {
  beforeEach(() => {
    for (const k of ENV_KEYS) saved[k] = process.env[k]
    process.env.GIFT_CAMPAIGN_ENABLED = 'true'
    process.env.GIFT_CAMPAIGN_TOKEN_SECRET = 'entitlement-secret'
    process.env.PUBLIC_SITE_URL = 'https://shop.example/'
    delete process.env.GIFT_CAMPAIGN_MAX_PER_CUSTOMER
  })
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    }
  })

  it('issues a hashed link for a qualifying order and emails the raw link only', async () => {
    const { svc, tx, email, prisma } = setup()
    const out = await svc.issueForOrder('order-1')
    expect(out).toEqual({ issued: true, entitlementId: 'ent-1' })

    const salt = tx.giftCampaignEntitlement.create.mock.calls[0][0].data.tokenSalt
    const token = deriveLinkToken('entitlement-secret', 'ent-1', salt)
    expect(tx.giftCampaignEntitlement.update).toHaveBeenCalledWith({ where: { id: 'ent-1' }, data: { tokenHash: hashLinkToken(token) } })
    expect(JSON.stringify(tx.giftCampaignEntitlement.create.mock.calls)).not.toContain(token)

    const sent = email.sendGiftCampaignEmail.mock.calls[0][0]
    expect(sent).toMatchObject({ kind: 'link_issued', to: 'ada@example.com' })
    expect(sent.link).toBe(`https://shop.example/en/gift/${token}`)
    expect(sent.link).not.toMatch(/cust-1|order-1|ent-1|447400123456/)
    expect(prisma.giftCampaignEntitlement.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ linkDeliveryChannel: 'email', linkDeliveredAt: expect.any(Date) }) }),
    )
  })

  it('serialises issuance per customer with an advisory lock', async () => {
    const { svc, tx } = setup()
    await svc.issueForOrder('order-1')
    expect(tx.$executeRaw).toHaveBeenCalled()
  })

  it('enforces one reward per customer by default', async () => {
    const { svc, tx, email } = setup(fulfilledOrder(), 1)
    expect(await svc.issueForOrder('order-1')).toEqual({ issued: false, reason: 'CUSTOMER_LIMIT' })
    expect(tx.giftCampaignEntitlement.create).not.toHaveBeenCalled()
    expect(email.sendGiftCampaignEmail).not.toHaveBeenCalled()
  })

  it('allows more per customer when configured', async () => {
    process.env.GIFT_CAMPAIGN_MAX_PER_CUSTOMER = '2'
    const { svc } = setup(fulfilledOrder(), 1)
    expect((await svc.issueForOrder('order-1')).issued).toBe(true)
  })

  it('is a no-op on a replayed fulfilment (unique orderId)', async () => {
    const { svc, prisma, email } = setup()
    prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
    expect(await svc.issueForOrder('order-1')).toEqual({ issued: false, reason: 'ALREADY_ISSUED' })
    expect(email.sendGiftCampaignEmail).not.toHaveBeenCalled()
  })

  it.each([
    ['a guest order', fulfilledOrder({ customerId: null, customer: null }), 'GUEST_ORDER'],
    ['a refunded order', fulfilledOrder({ refunded: true }), 'REFUNDED_OR_DISPUTED'],
    ['an undelivered order', fulfilledOrder({ status: 'PAID' }), 'NOT_FULFILLED'],
  ])('issues nothing for %s', async (_l, order, reason) => {
    const { svc, prisma } = setup(order)
    expect(await svc.issueForOrder('order-1')).toEqual({ issued: false, reason })
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('does nothing while the campaign is disabled', async () => {
    process.env.GIFT_CAMPAIGN_ENABLED = 'false'
    const { svc, prisma } = setup()
    expect(await svc.issueForOrder('order-1')).toEqual({ issued: false, reason: 'CAMPAIGN_DISABLED' })
    expect(prisma.order.findUnique).not.toHaveBeenCalled()
  })

  it('refuses to issue without a secret', async () => {
    delete process.env.GIFT_CAMPAIGN_TOKEN_SECRET
    delete process.env.JWT_SECRET
    const { svc } = setup()
    expect(await svc.issueForOrder('order-1')).toEqual({ issued: false, reason: 'NO_SECRET' })
  })

  it('records a failed link delivery so support can resend', async () => {
    const { svc, email, prisma } = setup()
    email.sendGiftCampaignEmail.mockResolvedValue(false)
    await svc.issueForOrder('order-1')
    expect(prisma.giftCampaignEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: 'LINK_DELIVERY_FAILED' }) }),
    )
  })

  it('onOrderFulfilled never throws, so it cannot break fulfilment', async () => {
    const { svc, prisma } = setup()
    prisma.order.findUnique.mockRejectedValue(new Error('db down'))
    await expect(svc.onOrderFulfilled('order-1')).resolves.toEqual({ issued: false, reason: 'ERROR' })
  })
})
