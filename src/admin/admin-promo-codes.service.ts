import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common'
import type { Prisma } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { normalizePromoCode } from '../promo/promo.service'
import { randomInt } from 'node:crypto'
import { CreatePromoCodeBatchDto, CreatePromoCodeDto, UpdatePromoCodeDto } from './dto/promo-code.dto'
import { auditExport, CsvColumn, toCsv } from './csv-export'

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

type AdminPromo = ReturnType<typeof toAdminPromo>

const PROMO_EXPORT_COLUMNS: CsvColumn<AdminPromo>[] = [
  ['code', (p) => p.code],
  ['description', (p) => p.description],
  ['active', (p) => p.active],
  ['discountType', (p) => p.discountType],
  ['value', (p) => p.value],
  ['maxDiscountGbp', (p) => p.maxDiscountGbp],
  ['minOrderGbp', (p) => p.minOrderGbp],
  ['productTypes', (p) => p.productTypes],
  ['startsAt', (p) => p.startsAt],
  ['endsAt', (p) => p.endsAt],
  ['maxRedemptions', (p) => p.maxRedemptions],
  ['perCustomerLimit', (p) => p.perCustomerLimit],
  ['allowFullDiscount', (p) => p.allowFullDiscount],
  ['redemptionCount', (p) => p.redemptionCount],
  ['createdAt', (p) => p.createdAt],
]

// No 0/O, 1/I/L: these codes are read aloud and typed in by hand.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 8

function randomSuffix(): string {
  let out = ''
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
  return out
}

const toDate = (v: string | null | undefined) => (v === undefined ? undefined : v === null ? null : new Date(v))

@Injectable()
export class AdminPromoCodesService {
  constructor(private readonly prisma: PrismaService) {}

  async list() {
    const rows = await this.prisma.promoCode.findMany({ orderBy: { createdAt: 'desc' }, include: WITH_COUNT })
    return rows.map(toAdminPromo)
  }

  async exportCsv(admin: AuthenticatedAdmin): Promise<string> {
    const rows = await this.list()
    await auditExport(this.prisma, admin, 'export_promo_codes', rows.length)
    return toCsv(PROMO_EXPORT_COLUMNS, rows)
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
      allowFullDiscount: dto.allowFullDiscount ?? false,
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

  /**
   * Generate `count` single-use codes (maxRedemptions 1, perCustomerLimit 1) sharing the
   * same discount rules, e.g. 100% grocery-voucher codes for a selected group. Returns the
   * codes so they can be handed out; they also appear in the list and CSV export.
   */
  async createBatch(dto: CreatePromoCodeBatchDto, actor: AuthenticatedAdmin) {
    const prefix = normalizePromoCode(dto.prefix)
    const shared = {
      description: dto.description ?? null,
      discountType: dto.discountType,
      value: dto.value,
      maxDiscountGbp: dto.maxDiscountGbp ?? null,
      minOrderGbp: dto.minOrderGbp ?? null,
      productTypes: dto.productTypes ?? [],
      startsAt: toDate(dto.startsAt) ?? null,
      endsAt: toDate(dto.endsAt) ?? null,
      maxRedemptions: 1,
      perCustomerLimit: 1,
      active: true,
      allowFullDiscount: dto.allowFullDiscount ?? false,
    }
    this.assertCoherent(shared)

    // Random suffixes (31^8 ≈ 850 billion) can, very rarely, collide with an existing code.
    // Those are left out, and the loop tops the batch back up.
    const codes: string[] = []
    for (let round = 0; codes.length < dto.count && round < 5; round++) {
      const wanted = new Set<string>()
      while (wanted.size < dto.count - codes.length) wanted.add(`${prefix}-${randomSuffix()}`)
      const taken = await this.prisma.promoCode.findMany({
        where: { code: { in: [...wanted] } },
        select: { code: true },
      })
      const fresh = [...wanted].filter((code) => !taken.some((t) => t.code === code))
      await this.prisma.promoCode.createMany({
        data: fresh.map((code) => ({ ...shared, code })),
        skipDuplicates: true,
      })
      codes.push(...fresh)
    }
    if (codes.length < dto.count) {
      throw new ConflictException(`Only ${codes.length} of ${dto.count} codes could be created; try again`)
    }

    await this.audit(actor, 'promo_code_batch_create', prefix, `${codes.length} single-use codes`)
    return { count: codes.length, codes }
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
