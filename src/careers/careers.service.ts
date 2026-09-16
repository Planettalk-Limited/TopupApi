import { Injectable, NotFoundException } from '@nestjs/common'
import { JobStatus } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'

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
  constructor(private readonly prisma: PrismaService) {}

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
}
