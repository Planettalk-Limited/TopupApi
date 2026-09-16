import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { JobStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { CareersStorageService } from './careers-storage.service'
import { CareersEmailService } from './careers-email.service'
import { SubmitApplicationDto } from './dto/submit-application.dto'

const PUBLIC_LIST_SELECT = {
  id: true,
  slug: true,
  title: true,
  department: true,
  location: true,
  employmentType: true,
  createdAt: true,
} as const

@Injectable()
export class CareersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: CareersStorageService,
    private readonly email: CareersEmailService,
  ) {}

  listOpenJobs() {
    return this.prisma.jobPosting.findMany({
      where: { status: JobStatus.OPEN },
      select: PUBLIC_LIST_SELECT,
      orderBy: { createdAt: 'desc' },
    })
  }

  async getJobById(id: string) {
    const job = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!job) throw new NotFoundException('Job posting not found')
    return job
  }

  async submitApplication(
    jobId: string,
    dto: SubmitApplicationDto,
    cv: { buffer: Buffer; mimetype: string; size: number; originalname: string },
  ) {
    const job = await this.prisma.jobPosting.findUnique({ where: { id: jobId } })
    if (!job) throw new NotFoundException('Job posting not found')
    if (job.status !== JobStatus.OPEN) {
      throw new BadRequestException('That role is no longer accepting applications')
    }

    const ALLOWED_CV_TYPES = [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    ]
    const CV_MAX_BYTES = 5 * 1024 * 1024
    if (!ALLOWED_CV_TYPES.includes(cv.mimetype)) {
      throw new BadRequestException('CV must be a PDF or Word document')
    }
    if (cv.size > CV_MAX_BYTES) {
      throw new BadRequestException('CV must be 5MB or smaller')
    }

    const application = await this.prisma.jobApplication.create({
      data: {
        jobPostingId: job.id,
        jobTitleSnapshot: job.title,
        firstName: dto.firstName,
        lastName: dto.lastName,
        email: dto.email,
        phone: dto.phone,
        linkedin: dto.linkedin,
        portfolio: dto.portfolio,
        currentTitle: dto.currentTitle,
        yearsExperience: dto.yearsExperience,
        preferredLocation: dto.preferredLocation,
        workPreference: dto.workPreference,
        rightToWork: dto.rightToWork,
        whyJoin: dto.whyJoin,
        cvKey: '', // set below after upload, updated in place
        cvOriginalFilename: cv.originalname,
        cvContentType: cv.mimetype,
        cvSizeBytes: cv.size,
      },
    })

    const extension = cv.mimetype === 'application/pdf' ? 'pdf' : 'docx'
    const cvKey = this.storage.generateCvKey(application.id, extension)
    await this.storage.uploadCv({ key: cvKey, body: cv.buffer, contentType: cv.mimetype })
    await this.prisma.jobApplication.update({ where: { id: application.id }, data: { cvKey } })

    await this.email.sendApplicationReceived({
      to: dto.email,
      jobTitle: job.title,
      applicantFirstName: dto.firstName,
    })
    await this.email.sendNewApplicationAlert({
      jobTitle: job.title,
      applicantName: `${dto.firstName} ${dto.lastName}`,
      applicationId: application.id,
    })

    return { id: application.id }
  }
}
