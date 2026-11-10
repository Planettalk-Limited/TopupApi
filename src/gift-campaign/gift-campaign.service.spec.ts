import { BadRequestException, ConflictException, GoneException, NotFoundException } from '@nestjs/common'
import { GiftCampaignService, SUBMISSION_RECEIVED_MESSAGE } from './gift-campaign.service'
import { readGiftCampaignConfig } from './gift-campaign.config'
import { deriveLinkToken, hashLinkToken } from './gift-token'

const SECRET = 'svc-secret'
const ENT_ID = 'ent-1'
const SALT = 'salt-1'
const TOKEN = deriveLinkToken(SECRET, ENT_ID, SALT)
const CONFIG = readGiftCampaignConfig({ GIFT_CAMPAIGN_ENABLED: 'true', GIFT_CAMPAIGN_TERMS_VERSION: 'v1' })

const body = {
  senderName: 'Ada Obi',
  senderEmail: 'ada@example.com',
  senderPhone: '+447400123456',
  recipientName: 'Chinedu Obi',
  recipientPhone: '+2348031234567',
  declarationAccepted: true,
  termsAccepted: true,
  termsVersion: 'v1',
}

function entitlement(over: Record<string, unknown> = {}) {
  return {
    id: ENT_ID,
    campaignKey: CONFIG.campaignKey,
    customerId: 'cust-1',
    orderId: 'order-1',
    tokenHash: hashLinkToken(TOKEN),
    tokenSalt: SALT,
    status: 'LINK_ISSUED',
    expiresAt: new Date(Date.now() + 86_400_000),
    firstOpenedAt: null,
    createdAt: new Date(),
    customer: { firstName: 'Ada', lastName: 'Obi', email: 'ada@example.com', phone: '+447400123456' },
    submission: null,
    ...over,
  }
}

function setup(row: ReturnType<typeof entitlement> | null = entitlement(), claimCount = 1) {
  const tx = {
    giftCampaignEntitlement: { updateMany: jest.fn().mockResolvedValue({ count: claimCount }) },
    giftCampaignSubmission: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'sub-1', ...data })),
      update: jest.fn().mockResolvedValue({}),
    },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    giftCampaignEntitlement: {
      findUnique: jest.fn().mockResolvedValue(row),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    giftCampaignSubmission: { count: jest.fn().mockResolvedValue(0) },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
    order: { findUnique: jest.fn().mockResolvedValue({ status: 'FULFILLED', refunded: false, disputed: false }) },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const entitlements = {
    secret: () => SECRET,
    config: () => CONFIG,
    linkFor: (r: { id: string }) => `https://site/en/gift/derived-${r.id}`,
  }
  const email = { sendGiftCampaignEmail: jest.fn().mockResolvedValue(true) }
  const svc = new GiftCampaignService(prisma as never, entitlements as never, email as never)
  return { svc, prisma, tx, email }
}

describe('GiftCampaignService', () => {
  describe('token resolution', () => {
    it('looks the link up by the hash of the token, never the raw token', async () => {
      const { svc, prisma } = setup()
      await svc.viewLink(TOKEN)
      expect(prisma.giftCampaignEntitlement.findUnique).toHaveBeenCalledWith(
        expect.objectContaining({ where: { tokenHash: hashLinkToken(TOKEN) } }),
      )
    })

    it('404s an unknown or malformed token without querying for junk', async () => {
      const { svc, prisma } = setup(null)
      await expect(svc.viewLink(TOKEN)).rejects.toBeInstanceOf(NotFoundException)
      await expect(svc.viewLink('not-a-token')).rejects.toBeInstanceOf(NotFoundException)
      expect(prisma.giftCampaignEntitlement.findUnique).toHaveBeenCalledTimes(1)
    })

    it('404s a token that hashes to a row but was not derived for it', async () => {
      const forged = 'B'.repeat(43)
      const { svc } = setup(entitlement({ tokenHash: hashLinkToken(forged) }))
      await expect(svc.viewLink(forged)).rejects.toBeInstanceOf(NotFoundException)
    })
  })

  describe('viewLink', () => {
    it('returns the prefilled sender for an open link, and no ids', async () => {
      const { svc } = setup()
      const view = await svc.viewLink(TOKEN)
      expect(view.state).toBe('open')
      expect(view.sender).toEqual({ fullName: 'Ada Obi', email: 'ada@example.com', phone: '+447400123456' })
      expect(JSON.stringify(view)).not.toMatch(/cust-1|order-1|ent-1/)
    })

    it('reports and records an expired link', async () => {
      const { svc, prisma } = setup(entitlement({ expiresAt: new Date(Date.now() - 1000) }))
      const view = await svc.viewLink(TOKEN)
      expect(view.state).toBe('expired')
      expect(view.sender).toBeUndefined()
      expect(prisma.giftCampaignEntitlement.updateMany).toHaveBeenCalledWith({
        where: { id: ENT_ID, status: 'LINK_ISSUED' },
        data: { status: 'EXPIRED' },
      })
    })

    it('reports a used link with its reference only', async () => {
      const { svc } = setup(
        entitlement({ status: 'SUBMITTED', submission: { reference: 'GFT-ABC', createdAt: new Date() } }),
      )
      const view = await svc.viewLink(TOKEN)
      expect(view.state).toBe('submitted')
      expect(view.submission?.reference).toBe('GFT-ABC')
      expect(view.sender).toBeUndefined()
    })
  })

  describe('submit', () => {
    it('stores the submission, moves it to PENDING_VALIDATION and acknowledges without confirming', async () => {
      const { svc, tx, email } = setup()
      const res = await svc.submit(TOKEN, body)
      expect(res.status).toBe('received')
      expect(res.message).toBe(SUBMISSION_RECEIVED_MESSAGE)
      expect(res.message).not.toMatch(/confirmed|won/i)
      expect(tx.giftCampaignEntitlement.updateMany).toHaveBeenCalledWith({
        where: { id: ENT_ID, status: 'LINK_ISSUED', expiresAt: { gt: expect.any(Date) } },
        data: { status: 'SUBMITTED' },
      })
      const created = tx.giftCampaignSubmission.create.mock.calls[0][0].data
      expect(created).toMatchObject({ status: 'SUBMITTED', termsVersion: 'v1', flags: [], eligibilityResult: 'PASSED' })
      expect(created.termsAcceptedAt).toBeInstanceOf(Date)
      expect(created.declarationAcceptedAt).toBeInstanceOf(Date)
      expect(tx.giftCampaignSubmission.update).toHaveBeenCalledWith({ where: { id: 'sub-1' }, data: { status: 'PENDING_VALIDATION' } })
      expect(email.sendGiftCampaignEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'submission_received' }))
    })

    it('is single use: a link already submitted is refused', async () => {
      const { svc, tx } = setup(entitlement({ status: 'SUBMITTED' }))
      await expect(svc.submit(TOKEN, body)).rejects.toBeInstanceOf(ConflictException)
      expect(tx.giftCampaignSubmission.create).not.toHaveBeenCalled()
    })

    it('is single use under a race: losing the guarded claim creates nothing', async () => {
      const { svc, tx } = setup(entitlement(), 0)
      await expect(svc.submit(TOKEN, body)).rejects.toBeInstanceOf(ConflictException)
      expect(tx.giftCampaignSubmission.create).not.toHaveBeenCalled()
    })

    it('maps a unique-constraint race to a conflict', async () => {
      const { svc, prisma } = setup()
      prisma.$transaction.mockRejectedValueOnce(Object.assign(new Error('dup'), { code: 'P2002' }))
      await expect(svc.submit(TOKEN, body)).rejects.toBeInstanceOf(ConflictException)
    })

    it('refuses an expired link', async () => {
      const { svc } = setup(entitlement({ expiresAt: new Date(Date.now() - 1) }))
      await expect(svc.submit(TOKEN, body)).rejects.toBeInstanceOf(GoneException)
    })

    it('refuses invalid details with every error', async () => {
      const { svc } = setup()
      const err = await svc.submit(TOKEN, { ...body, recipientPhone: '+447700900456', termsAccepted: false }).catch((e) => e)
      expect(err).toBeInstanceOf(BadRequestException)
      expect(JSON.stringify(err.getResponse())).toMatch(/\+234.*terms|terms.*\+234/)
    })

    it('refuses a stale terms version', async () => {
      const { svc } = setup()
      await expect(svc.submit(TOKEN, { ...body, termsVersion: 'v0' })).rejects.toBeInstanceOf(ConflictException)
    })

    it('flags duplicates for review instead of rejecting', async () => {
      const { svc, prisma, tx } = setup()
      prisma.giftCampaignSubmission.count.mockResolvedValueOnce(1) // same recipient phone
      await svc.submit(TOKEN, body)
      const created = tx.giftCampaignSubmission.create.mock.calls[0][0].data
      expect(created.flags).toEqual(['DUPLICATE_RECIPIENT_PHONE'])
      expect(created.eligibilityResult).toBe('NEEDS_REVIEW')
    })
  })

  it('lists the signed-in customer links with a re-derived link only while open', async () => {
    const { svc, prisma } = setup()
    prisma.giftCampaignEntitlement.findMany.mockResolvedValue([
      entitlement(),
      entitlement({ id: 'ent-2', status: 'SUBMITTED', submission: { reference: 'GFT-1', status: 'APPROVED', createdAt: new Date() } }),
    ])
    const res = await svc.listForCustomer('cust-1')
    expect(prisma.giftCampaignEntitlement.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { customerId: 'cust-1' } }))
    expect(res.entitlements[0].link).toBe('https://site/en/gift/derived-ent-1')
    expect(res.entitlements[1].link).toBeNull()
    expect(res.entitlements[1].submission?.status).toMatch(/Approved/)
  })
})
