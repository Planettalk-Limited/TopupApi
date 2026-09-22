import { CareersRetentionService, RETENTION_DAYS } from './careers-retention.service'

describe('CareersRetentionService', () => {
  let prisma: { jobApplication: { findMany: jest.Mock; delete: jest.Mock } }
  let storage: { deleteCv: jest.Mock }
  let alert: { notify: jest.Mock }
  let service: CareersRetentionService

  beforeEach(() => {
    prisma = { jobApplication: { findMany: jest.fn().mockResolvedValue([]), delete: jest.fn() } }
    storage = { deleteCv: jest.fn().mockResolvedValue(undefined) }
    alert = { notify: jest.fn().mockResolvedValue(undefined) }
    service = new CareersRetentionService(prisma as any, storage as any, alert as any)
  })

  it('queries only applications older than the retention window', async () => {
    await service.purgeExpired()
    const call = prisma.jobApplication.findMany.mock.calls[0][0]
    expect(call.where.submittedAt.lt).toBeInstanceOf(Date)
    const daysAgo = (Date.now() - call.where.submittedAt.lt.getTime()) / (1000 * 60 * 60 * 24)
    expect(Math.round(daysAgo)).toBe(RETENTION_DAYS)
  })

  it('deletes each expired application and its CV, continuing past a single failure', async () => {
    prisma.jobApplication.findMany.mockResolvedValue([
      { id: 'app-1', cvKey: 'cvs/app-1.pdf' },
      { id: 'app-2', cvKey: 'cvs/app-2.pdf' },
    ])
    storage.deleteCv.mockRejectedValueOnce(new Error('spaces down')).mockResolvedValueOnce(undefined)
    prisma.jobApplication.delete.mockResolvedValue({})

    await service.purgeExpired()

    expect(storage.deleteCv).toHaveBeenCalledTimes(2)
    // app-1's CV delete failed — the row must NOT be deleted (would orphan a CV we
    // couldn't confirm was removed); app-2 should still proceed despite app-1's failure.
    expect(prisma.jobApplication.delete).toHaveBeenCalledTimes(1)
    expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-2' } })
    expect(alert.notify).toHaveBeenCalled()
  })
})
