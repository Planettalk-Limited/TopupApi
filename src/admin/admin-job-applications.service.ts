import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { ApplicationStatus, JobApplication } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CareersStorageService } from '../careers/careers-storage.service'
import { CareersEmailService } from '../careers/careers-email.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { auditExport, CsvColumn, toCsv } from './csv-export'

// The CV itself stays behind the per-application download; only its filename is exported (never the storage key).
const APPLICATION_EXPORT_COLUMNS: CsvColumn<JobApplication>[] = [
  ['submittedAt', (a) => a.submittedAt],
  ['status', (a) => a.status],
  ['jobTitle', (a) => a.jobTitleSnapshot],
  ['firstName', (a) => a.firstName],
  ['lastName', (a) => a.lastName],
  ['email', (a) => a.email],
  ['phone', (a) => a.phone],
  ['country', (a) => a.country],
  ['city', (a) => a.city],
  ['currentTitle', (a) => a.currentTitle],
  ['yearsExperience', (a) => a.yearsExperience],
  ['preferredLocation', (a) => a.preferredLocation],
  ['workPreference', (a) => a.workPreference],
  ['rightToWork', (a) => a.rightToWork],
  ['linkedin', (a) => a.linkedin],
  ['portfolio', (a) => a.portfolio],
  ['whyJoin', (a) => a.whyJoin],
  ['cvFilename', (a) => a.cvOriginalFilename],
  ['rejectionSentAt', (a) => a.rejectionSentAt],
  ['id', (a) => a.id],
]

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

  /** Same filters as the list. Audited: applicant contact details. */
  async exportCsv(filter: { jobPostingId?: string; status?: ApplicationStatus }, admin: AuthenticatedAdmin): Promise<string> {
    const rows = await this.list(filter)
    await auditExport(this.prisma, admin, 'export_job_applications', rows.length, filter)
    return toCsv(APPLICATION_EXPORT_COLUMNS, rows)
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

    // cvKey can be '' when the two-phase write in submitApplication() never
    // completed the upload/update step — nothing was ever stored, so skip the
    // storage call rather than let deleteCv('') throw (a client-side S3 SDK
    // validation failure on an empty Key) and leave the row undeletable.
    if (application.cvKey) {
      await this.storage.deleteCv(application.cvKey)
    }
    await this.prisma.jobApplication.delete({ where: { id } })
    await this.audit(actor, 'application_delete', id, application.email)
    return { ok: true }
  }

  async getCv(id: string) {
    const application = await this.prisma.jobApplication.findUnique({ where: { id } })
    if (!application) throw new NotFoundException('Application not found')
    if (!application.cvKey) {
      throw new NotFoundException('This application has no CV on file')
    }
    const stream = await this.storage.getCvStream(application.cvKey)
    return { ...stream, filename: application.cvOriginalFilename }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
