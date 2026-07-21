import { Injectable, NotFoundException } from '@nestjs/common'
import { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { ListCreditbackDto } from './dto/list-creditback.dto'
import { UpdateCreditbackStatusDto } from './dto/update-creditback-status.dto'

/**
 * Admin view over the PlanetTalk Creditback claim leads. Ops uses this to work
 * through NEW claims: match each against a PlanetTalk app account, apply the
 * credit, then mark CREDITED (or REJECTED). Every status change is audited.
 */
@Injectable()
export class AdminCreditbackService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCreditbackDto) {
    const page = query.page ?? 1
    const pageSize = query.pageSize ?? 25
    const where: Prisma.CreditbackClaimWhereInput = {}
    if (query.status) where.status = query.status
    if (query.countryCode) where.countryCode = query.countryCode

    const search = query.search?.trim()
    if (search) {
      where.OR = [
        { email: { contains: search, mode: 'insensitive' } },
        { phone: { contains: search, mode: 'insensitive' } },
        { transactionId: { contains: search, mode: 'insensitive' } },
      ]
    }

    const [total, data] = await Promise.all([
      this.prisma.creditbackClaim.count({ where }),
      this.prisma.creditbackClaim.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
    ])

    return {
      data,
      pagination: { page, pageSize, total, totalPages: Math.ceil(total / pageSize) },
    }
  }

  async updateStatus(id: string, dto: UpdateCreditbackStatusDto, admin: AuthenticatedAdmin) {
    const existing = await this.prisma.creditbackClaim.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Claim not found')

    const updated = await this.prisma.creditbackClaim.update({
      where: { id },
      data: { status: dto.status },
    })

    await this.prisma.adminAuditLog.create({
      data: {
        adminId: admin.id,
        action: 'creditback_status_change',
        target: id,
        result: `${existing.status} -> ${dto.status}`,
      },
    })

    return updated
  }
}
