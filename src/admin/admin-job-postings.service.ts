import { Injectable, NotFoundException } from '@nestjs/common'
import { randomBytes } from 'crypto'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { CreateJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto'

function slugify(title: string): string {
  const base = title.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')
  const suffix = randomBytes(3).toString('hex')
  return `${base}-${suffix}`
}

@Injectable()
export class AdminJobPostingsService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.jobPosting.findMany({ orderBy: { createdAt: 'desc' } })
  }

  async create(dto: CreateJobPostingDto, actor: AuthenticatedAdmin) {
    const posting = await this.prisma.jobPosting.create({
      data: { ...dto, slug: slugify(dto.title), createdByAdminId: actor.id },
    })
    await this.audit(actor, 'job_posting_create', posting.id, posting.title)
    return posting
  }

  async update(id: string, dto: UpdateJobPostingDto, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Job posting not found')

    const posting = await this.prisma.jobPosting.update({ where: { id }, data: dto })
    await this.audit(actor, 'job_posting_update', id, JSON.stringify(dto))
    return posting
  }

  async remove(id: string, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.jobPosting.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Job posting not found')

    // Deliberately does NOT touch applications — jobPostingId goes null via
    // the schema's onDelete: SetNull, jobTitleSnapshot preserves what it was for.
    await this.prisma.jobPosting.delete({ where: { id } })
    await this.audit(actor, 'job_posting_delete', id, existing.title)
    return { ok: true }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
