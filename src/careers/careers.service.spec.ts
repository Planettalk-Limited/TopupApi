import { NotFoundException } from '@nestjs/common'
import { CareersService } from './careers.service'

describe('CareersService', () => {
  let prisma: { jobPosting: { findMany: jest.Mock; findUnique: jest.Mock } }
  let service: CareersService

  beforeEach(() => {
    prisma = {
      jobPosting: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
    }
    service = new CareersService(prisma as any)
  })

  describe('listOpenJobs', () => {
    it('queries only OPEN postings, newest first, whitelisted fields', async () => {
      await service.listOpenJobs()
      expect(prisma.jobPosting.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { status: 'OPEN' },
          orderBy: { createdAt: 'desc' },
        }),
      )
      const call = prisma.jobPosting.findMany.mock.calls[0][0]
      expect(call.select).toMatchObject({
        id: true,
        slug: true,
        title: true,
        department: true,
        location: true,
        employmentType: true,
        createdAt: true,
      })
      expect(call.select.description).toBeUndefined()
    })
  })

  describe('getJobById', () => {
    it('throws NotFoundException when the id does not exist', async () => {
      prisma.jobPosting.findUnique.mockResolvedValue(null)
      await expect(service.getJobById('missing')).rejects.toBeInstanceOf(NotFoundException)
    })

    it('returns the job regardless of status (closed roles still resolve)', async () => {
      const closedJob = { id: 'job-1', status: 'CLOSED', title: 'X' }
      prisma.jobPosting.findUnique.mockResolvedValue(closedJob)
      const result = await service.getJobById('job-1')
      expect(result).toEqual(closedJob)
    })
  })
})
