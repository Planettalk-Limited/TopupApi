import { NotFoundException } from '@nestjs/common'
import { CareersService } from './careers.service'

describe('CareersService', () => {
  let prisma: {
    jobPosting: { findMany: jest.Mock; findUnique: jest.Mock }
    jobApplication: { create: jest.Mock; update: jest.Mock }
  }
  let service: CareersService

  beforeEach(() => {
    prisma = {
      jobPosting: { findMany: jest.fn().mockResolvedValue([]), findUnique: jest.fn() },
      jobApplication: { create: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    }
    service = new CareersService(prisma as any, {} as any, {} as any)
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

  describe('submitApplication', () => {
    let storage: { generateCvKey: jest.Mock; uploadCv: jest.Mock }
    let email: { sendApplicationReceived: jest.Mock; sendNewApplicationAlert: jest.Mock }

    beforeEach(() => {
      storage = {
        generateCvKey: jest.fn().mockReturnValue('cvs/app-1.pdf'),
        uploadCv: jest.fn().mockResolvedValue(undefined),
      }
      email = {
        sendApplicationReceived: jest.fn().mockResolvedValue(undefined),
        sendNewApplicationAlert: jest.fn().mockResolvedValue(undefined),
      }
      ;(service as any).storage = storage
      ;(service as any).email = email
    })

    const validDto = {
      firstName: 'Jamie',
      lastName: 'Doe',
      email: 'jamie@example.com',
      yearsExperience: '3–5 years',
      preferredLocation: 'UK',
      workPreference: 'Remote',
      rightToWork: 'Yes',
      whyJoin: 'Because PlanetTalk matters to me.',
    }
    const cvFile = {
      buffer: Buffer.from('pdf'),
      mimetype: 'application/pdf',
      size: 1024,
      originalname: 'resume.pdf',
    }

    it('rejects when the job does not exist', async () => {
      prisma.jobPosting.findUnique.mockResolvedValue(null)
      await expect(service.submitApplication('missing', validDto as any, cvFile as any)).rejects.toThrow()
    })

    it('rejects when the job is closed', async () => {
      prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', status: 'CLOSED', title: 'X' })
      await expect(service.submitApplication('job-1', validDto as any, cvFile as any)).rejects.toThrow()
    })

    it('creates the application, uploads the CV, and sends both emails on success', async () => {
      prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', status: 'OPEN', title: 'Backend Engineer' })
      prisma.jobApplication = {
        create: jest.fn().mockResolvedValue({ id: 'app-1', ...validDto }),
        update: jest.fn().mockResolvedValue({}),
      }
      const result = await service.submitApplication('job-1', validDto as any, cvFile as any)
      expect(prisma.jobApplication.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ cvOriginalFilename: 'resume.pdf' }),
        }),
      )
      expect(storage.uploadCv).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'cvs/app-1.pdf', contentType: 'application/pdf' }),
      )
      expect(email.sendApplicationReceived).toHaveBeenCalled()
      expect(email.sendNewApplicationAlert).toHaveBeenCalled()
      expect(result).toEqual({ id: 'app-1' })
    })
  })
})
