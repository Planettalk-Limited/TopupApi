import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ApplicationStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CareersStorageService } from '../careers/careers-storage.service'
import { CareersEmailService } from '../careers/careers-email.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

@Injectable()
export class AdminJobApplicationsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CareersStorageService,
    private readonly email: CareersEmailService,
  ) {}

  list(filter: { jobPostingId?: string; status?: ApplicationStatus }) {
    return this.prisma.jobApplication.findMany({
      where: {
        ...(filter.jobPostingId ? { jobPostingId: filter.jobPostingId } : {}),
        ...(filter.status ? { status: filter.status } : {}),
      },
      orderBy: { submittedAt: 'desc' },
    })
  }

  async setStatus(id: string, status: ApplicationStatus, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Application not found')

    const application = await this.prisma.jobApplication.update({ where: { id }, data: { status } })
    await this.audit(actor, 'application_set_status', id, status)
    return application
  }

  // Sending the rejection is a distinct action from setting status=REJECTED, never
  // a side effect of it — matches the Astro implementation's explicit design (an
  // admin might mark REJECTED internally before deciding to notify the candidate).
  async reject(id: string, actor: AuthenticatedAdmin) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')
    if (application.status !== ApplicationStatus.REJECTED) {
      throw new BadRequestException('Set status to REJECTED before sending the rejection email')
    }
    if (application.rejectionSentAt) {
      throw new BadRequestException('Rejection email already sent for this application')
    }

    const sent = await this.email.sendRejection({
      to: application.email,
      applicantFirstName: application.firstName,
      jobTitle: application.jobTitleSnapshot,
    })
    if (!sent) {
      throw new BadRequestException('Failed to send rejection email — Mailgun rejected or is unconfigured')
    }

    await this.prisma.jobApplication.update({ where: { id }, data: { rejectionSentAt: new Date() } })
    await this.audit(actor, 'application_reject_sent', id, application.email)
    return { ok: true }
  }

  async remove(id: string, actor: AuthenticatedAdmin) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')

    await this.storage.deleteCv(application.cvKey)
    await this.prisma.jobApplication.delete({ where: { id } })
    await this.audit(actor, 'application_delete', id, application.email)
    return { ok: true }
  }

  async getCv(id: string) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')
    const stream = await this.storage.getCvStream(application.cvKey)
    return { ...stream, filename: application.cvOriginalFilename }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
