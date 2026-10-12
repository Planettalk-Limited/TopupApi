import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { normalizePromoCode } from '../promo/promo.service'
import { CreatePromoCodeDto, UpdatePromoCodeDto } from './dto/promo-code.dto'

const WITH_COUNT = { _count: { select: { redemptions: true } } } as const

type PromoRow = Prisma.PromoCodeGetPayload<{ include: typeof WITH_COUNT }>

const num = (v: Prisma.Decimal | number | null | undefined) => (v === null || v === undefined ? null : Number(v))

/** Admin-facing shape: Decimal columns as plain numbers, plus how often the code was used. */
function toAdminPromo(row: PromoRow) {
  const { _count, ...rest } = row
  return {
    ...rest,
    value: Number(row.value),
    maxDiscountGbp: num(row.maxDiscountGbp),
    minOrderGbp: num(row.minOrderGbp),
    redemptionCount: _count?.redemptions ?? 0,
  }
}

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v))

@Injectable()
export class AdminPromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, include: WITH_COUNT })
    return rows.map(toAdminPromo)
  }

  async create(dto: CreatePromoCodeDto, actor: AuthenticatedAdmin) {
    const data = {
      code: normalizePromoCode(dto.code),
      description: dto.description ?? null,
      discountType: dto.discountType,
      value: dto.value,
      maxDiscountGbp: dto.maxDiscountGbp ?? null,
      minOrderGbp: dto.minOrderGbp ?? null,
      productTypes: dto.productTypes ?? [],
      startsAt: toDate(dto.startsAt) ?? null,
      endsAt: toDate(dto.endsAt) ?? null,
      maxRedemptions: dto.maxRedemptions ?? null,
      perCustomerLimit: dto.perCustomerLimit ?? 1,
      active: dto.active ?? true,
    }
    this.assertCoherent(data)

    let created: PromoRow
    try {
      created = await this.prisma.promoCode.create({ data, include: WITH_COUNT })
    } catch (error) {
      if ((error as { code?: string })?.code === 'P2002') {
        throw new ConflictException('A promo code with this code already exists')
      }
      throw error
    }
    await this.audit(actor, 'promo_code_create', created.id, created.code)
    return toAdminPromo(created)
  }

  async update(id: string, dto: UpdatePromoCodeDto, actor: AuthenticatedAdmin) {
    const existing = await this.prisma.promoCode.findUnique({ where: { id } })
    if (!existing) throw new NotFoundException('Promo code not found')

    const data: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(dto)) {
      if (value === undefined) continue
      data[key] = key === 'startsAt' || key === 'endsAt' ? toDate(value as string | null) : value
    }
    // Validate the code as it will be after the PATCH, not the PATCH in isolation.
    this.assertCoherent({
      discountType: (data.discountType as string) ?? existing.discountType,
      value: (data.value as number) ?? Number(existing.value),
      startsAt: 'startsAt' in data ? (data.startsAt as Date | null) : existing.startsAt,
      endsAt: 'endsAt' in data ? (data.endsAt as Date | null) : existing.endsAt,
    })

    const updated = await this.prisma.promoCode.update({ where: { id }, data, include: WITH_COUNT })
    await this.audit(actor, 'promo_code_update', id, JSON.stringify(dto))
    return toAdminPromo(updated)
  }

  private assertCoherent(p: { discountType: string; value: number; startsAt: Date | null; endsAt: Date | null }) {
    if (p.discountType === 'PERCENT' && p.value > 100) {
      throw new BadRequestException('A percentage discount cannot exceed 100')
    }
    if (p.startsAt && p.endsAt && p.endsAt.getTime() <= p.startsAt.getTime()) {
      throw new BadRequestException('endsAt must be after startsAt')
    }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({ data: { adminId: actor.id, action, target, result } })
  }
}
