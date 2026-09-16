import { BadRequestException, NotFoundException } from '@nestjs/common'
import { AdminJobApplicationsService } from './admin-job-applications.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

const admin: AuthenticatedAdmin = { id: 'admin-1', email: 'a@example.com', name: 'A', role: 'ADMIN' as AuthenticatedAdmin['role'] }

describe('AdminJobApplicationsService', () => {
  let prisma: {
    jobApplication: { findMany: jest.Mock; findUnique: jest.Mock; update: jest.Mock; delete: jest.Mock }
    adminAuditLog: { create: jest.Mock }
  }
  let storage: { getCvStream: jest.Mock; deleteCv: jest.Mock }
  let email: { sendRejection: jest.Mock }
  let service: AdminJobApplicationsService

  beforeEach(() => {
    prisma = {
      jobApplication: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      adminAuditLog: { create: jest.fn().mockResolvedValue({}) },
    }
    storage = { getCvStream: jest.fn(), deleteCv: jest.fn().mockResolvedValue(undefined) }
    email = { sendRejection: jest.fn() }
    service = new AdminJobApplicationsService(prisma as any, storage as any, email as any)
  })

  describe('setStatus', () => {
    it('updates status and audits it', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'NEW' })
      prisma.jobApplication.update.mockResolvedValue({ id: 'app-1', status: 'SHORTLISTED' })
      const result = await service.setStatus('app-1', 'SHORTLISTED' as any, admin)
      expect(result.status).toBe('SHORTLISTED')
      expect(prisma.adminAuditLog.create).toHaveBeenCalled()
    })
  })

  describe('reject', () => {
    it('requires status to already be REJECTED before sending', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', status: 'NEW', email: 'x@example.com' })
      await expect(service.reject('app-1', admin)).rejects.toBeInstanceOf(BadRequestException)
      expect(email.sendRejection).not.toHaveBeenCalled()
    })

    it('refuses to send twice — checks rejectionSentAt', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', rejectionSentAt: new Date(),
      })
      await expect(service.reject('app-1', admin)).rejects.toBeInstanceOf(BadRequestException)
      expect(email.sendRejection).not.toHaveBeenCalled()
    })

    it('sends the rejection and stamps rejectionSentAt only on confirmed success', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', firstName: 'Jamie',
        jobTitleSnapshot: 'Backend Engineer', rejectionSentAt: null,
      })
      email.sendRejection.mockResolvedValue(true)
      await service.reject('app-1', admin)
      expect(prisma.jobApplication.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'app-1' }, data: expect.objectContaining({ rejectionSentAt: expect.any(Date) }) }),
      )
    })

    it('does NOT stamp rejectionSentAt when the send fails', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({
        id: 'app-1', status: 'REJECTED', email: 'x@example.com', firstName: 'Jamie',
        jobTitleSnapshot: 'Backend Engineer', rejectionSentAt: null,
      })
      email.sendRejection.mockResolvedValue(false)
      await expect(service.reject('app-1', admin)).rejects.toThrow()
      expect(prisma.jobApplication.update).not.toHaveBeenCalled()
    })
  })

  describe('remove', () => {
    it('deletes the application and its CV together', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', cvKey: 'cvs/app-1.pdf', email: 'x@example.com' })
      await service.remove('app-1', admin)
      expect(storage.deleteCv).toHaveBeenCalledWith('cvs/app-1.pdf')
      expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } })
    })

    // Regression test for the orphaned cvKey: '' row: if submitApplication()'s upload
    // or follow-up update never completed, deleteCv('') would throw (a client-side
    // S3 SDK validation failure on an empty Key), leaving the row permanently
    // undeletable. remove() must skip the storage call and still delete the row.
    it('succeeds when cvKey is empty, without calling storage.deleteCv', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', cvKey: '', email: 'x@example.com' })
      const result = await service.remove('app-1', admin)
      expect(storage.deleteCv).not.toHaveBeenCalled()
      expect(prisma.jobApplication.delete).toHaveBeenCalledWith({ where: { id: 'app-1' } })
      expect(result).toEqual({ ok: true })
    })
  })

  describe('getCv', () => {
    it('throws NotFoundException when the application does not exist', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue(null)
      await expect(service.getCv('missing')).rejects.toBeInstanceOf(NotFoundException)
    })

    it('gives a clear NotFoundException for an empty cvKey instead of erroring in storage', async () => {
      prisma.jobApplication.findUnique.mockResolvedValue({ id: 'app-1', cvKey: '', email: 'x@example.com' })
      await expect(service.getCv('app-1')).rejects.toBeInstanceOf(NotFoundException)
      expect(storage.getCvStream).not.toHaveBeenCalled()
    })
  })
})
