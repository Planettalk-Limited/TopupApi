import { NotFoundException } from '@nestjs/common'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

const admin: AuthenticatedAdmin = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 'ADMIN' as AuthenticatedAdmin['role'] }

describe('AdminJobPostingsService', () => {
  let prisma: {
    jobPosting: { findMany: jest.Mock; create: jest.Mock; update: jest.Mock; delete: jest.Mock; findUnique: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let service: AdminJobPostingsService

  beforeEach(() => {
    prisma = {
      jobPosting: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
        findUnique: jest.fn(),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    service = new AdminJobPostingsService(prisma as any)
  })

  it('lists all postings regardless of status, newest first', async () => {
    await service.list()
    expect(prisma.jobPosting.findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } })
  })

  it('creates a posting, generates a slug, and audits it', async () => {
    prisma.jobPosting.create.mockResolvedValue({ id: 'job-1', title: 'Backend Engineer', slug: 'backend-engineer-ab12cd' })
    const dto = { title: 'Backend Engineer', department: 'Engineering', location: 'Remote', employmentType: 'Full-time', description: 'desc' }
    const result = await service.create(dto as any, admin)
    expect(prisma.jobPosting.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ title: 'Backend Engineer', createdByAdminId: 'admin-1' }) }),
    )
    expect(result.id).toBe('job-1')
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'job_posting_create', target: 'job-1', result: 'Backend Engineer' },
    })
  })

  it('throws NotFoundException when updating a posting that does not exist', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue(null)
    await expect(service.update('missing', { title: 'X' } as any, admin)).rejects.toBeInstanceOf(NotFoundException)
  })

  it('deletes a posting without touching its applications, and audits it', async () => {
    prisma.jobPosting.findUnique.mockResolvedValue({ id: 'job-1', title: 'Backend Engineer' })
    await service.remove('job-1', admin)
    expect(prisma.jobPosting.delete).toHaveBeenCalledWith({ where: { id: 'job-1' } })
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'admin-1', action: 'job_posting_delete', target: 'job-1', result: 'Backend Engineer' },
    })
  })
})
