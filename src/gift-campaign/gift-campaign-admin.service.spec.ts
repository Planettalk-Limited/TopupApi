import { BadRequestException, ConflictException } from '@nestjs/common'
import { GiftCampaignAdminService } from './gift-campaign-admin.service'
import { readGiftCampaignConfig } from './gift-campaign.config'

const admin = { id: 'admin-1', email: 'a@x', name: 'A', role: 'ADMIN' as const }

function setup(status = 'PENDING_VALIDATION', moved = 1) {
  const current = {
    id: 'sub-1',
    reference: 'GFT-ABC',
    status,
    voucherOrderId: 'order-v1',
    senderEmail: 'ada@example.com',
    customer: { firstName: 'Ada' },
  }
  const tx = {
    giftCampaignSubmission: { updateMany: jest.fn().mockResolvedValue({ count: moved }) },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
  }
  const prisma = {
    giftCampaignSubmission: {
      findUnique: jest.fn().mockResolvedValue(current),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    giftCampaignEvent: { create: jest.fn().mockResolvedValue({}) },
    adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    $transaction: jest.fn().mockImplementation((fn: (t: typeof tx) => unknown) => fn(tx)),
  }
  const email = { sendGiftCampaignEmail: jest.fn().mockResolvedValue(true) }
  const entitlements = { config: () => readGiftCampaignConfig({ GIFT_CAMPAIGN_ENABLED: 'true' }) }
  const svc = new GiftCampaignAdminService(prisma as never, email as never, entitlements as never)
  jest.spyOn(svc, 'get').mockResolvedValue({} as never)
  return { svc, prisma, tx, email }
}

describe('GiftCampaignAdminService.transition', () => {
  it('approves with a guarded update, audit trail and the approval email', async () => {
    const { svc, tx, email, prisma } = setup()
    await svc.transition('sub-1', { status: 'APPROVED' }, admin)
    expect(tx.giftCampaignSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', status: 'PENDING_VALIDATION' },
      data: expect.objectContaining({ status: 'APPROVED', approvedAt: expect.any(Date) }),
    })
    expect(tx.giftCampaignEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'STATUS_CHANGED', fromStatus: 'PENDING_VALIDATION', toStatus: 'APPROVED', adminId: 'admin-1' }),
    })
    expect(email.sendGiftCampaignEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'approved', to: 'ada@example.com' }))
    expect(prisma.adminAuditLog.create).toHaveBeenCalled()
  })

  it('refuses a disallowed move with 400 and changes nothing', async () => {
    const { svc, tx, email } = setup('PENDING_VALIDATION')
    await expect(svc.transition('sub-1', { status: 'FULFILLED', note: 'x' }, admin)).rejects.toBeInstanceOf(BadRequestException)
    expect(tx.giftCampaignSubmission.updateMany).not.toHaveBeenCalled()
    expect(email.sendGiftCampaignEmail).not.toHaveBeenCalled()
  })

  it('refuses a rejection without a reason code', async () => {
    const { svc } = setup()
    await expect(svc.transition('sub-1', { status: 'REJECTED' }, admin)).rejects.toBeInstanceOf(BadRequestException)
  })

  it('sends a customer-safe rejection reason', async () => {
    const { svc, email } = setup()
    await svc.transition('sub-1', { status: 'REJECTED', reasonCode: 'SUSPECTED_FRAUD' }, admin)
    expect(email.sendGiftCampaignEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'rejected', reason: null }))
  })

  it('409s when someone else moved the case first', async () => {
    const { svc, email } = setup('PENDING_VALIDATION', 0)
    await expect(svc.transition('sub-1', { status: 'APPROVED' }, admin)).rejects.toBeInstanceOf(ConflictException)
    expect(email.sendGiftCampaignEmail).not.toHaveBeenCalled()
  })

  it('closes a fulfilled case as SENDER_NOTIFIED once the completion email is sent', async () => {
    const { svc, prisma, email } = setup('AWAITING_REDEMPTION')
    await svc.transition('sub-1', { status: 'FULFILLED', note: 'Recipient confirmed redemption by phone' }, admin)
    expect(email.sendGiftCampaignEmail).toHaveBeenCalledWith(expect.objectContaining({ kind: 'fulfilled' }))
    expect(prisma.giftCampaignSubmission.updateMany).toHaveBeenCalledWith({
      where: { id: 'sub-1', status: 'FULFILLED' },
      data: expect.objectContaining({ status: 'SENDER_NOTIFIED' }),
    })
  })

  it('leaves a fulfilled case open when the completion email fails', async () => {
    const { svc, prisma, email } = setup('AWAITING_REDEMPTION')
    email.sendGiftCampaignEmail.mockResolvedValue(false)
    await svc.transition('sub-1', { status: 'FULFILLED', note: 'Collected in store' }, admin)
    expect(prisma.giftCampaignSubmission.updateMany).not.toHaveBeenCalled()
    expect(prisma.giftCampaignEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ type: 'NOTIFICATION_FAILED' }),
    })
  })
})
