import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common'
import { BeneficiaryKind } from '@prisma/client'
import { PrismaService } from '../common/prisma.service'
import { toE164Digits } from '../common/phone'

export const MAX_BENEFICIARIES = 50

export interface BeneficiaryInput {
  kind: 'PHONE' | 'METER' | 'EMAIL'
  label: string
  countryCode?: string
  phone?: string
  meterNumber?: string
  billerId?: number
  email?: string
}

function strip<T extends Record<string, unknown>>(row: T) {
  const { customerId: _customerId, ...rest } = row as T & { customerId?: unknown }
  return rest
}

/**
 * Saved recipients ("Top up Mum"). Purely a convenience for filling the checkout form —
 * nothing here is trusted at payment time; the order is validated and priced as usual.
 */
@Injectable()
export class BeneficiariesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(customerId: string) {
    const rows = await this.prisma.beneficiary.findMany({ where: { customerId }, orderBy: { createdAt: 'desc' } })
    return rows.map(strip)
  }

  async create(customerId: string, input: BeneficiaryInput) {
    const data = this.normalize(input)

    // Dedupe on kind + identifier: saving the same recipient twice returns the first entry.
    const identity =
      data.kind === BeneficiaryKind.PHONE
        ? { phone: data.phone }
        : data.kind === BeneficiaryKind.METER
          ? { billerId: data.billerId, meterNumber: data.meterNumber }
          : { email: data.email }
    const existing = await this.prisma.beneficiary.findFirst({ where: { customerId, kind: data.kind, ...identity } })
    if (existing) return strip(existing)

    const count = await this.prisma.beneficiary.count({ where: { customerId } })
    if (count >= MAX_BENEFICIARIES) {
      throw new BadRequestException({
        code: 'BENEFICIARY_LIMIT',
        message: `You can save up to ${MAX_BENEFICIARIES} recipients. Remove one to add another.`,
      })
    }

    const created = await this.prisma.beneficiary.create({ data: { customerId, ...data } })
    return strip(created)
  }

  async remove(customerId: string, id: string) {
    const { count } = await this.prisma.beneficiary.deleteMany({ where: { id, customerId } })
    if (count === 0) throw new NotFoundException('Beneficiary not found')
    return { ok: true }
  }

  private normalize(input: BeneficiaryInput) {
    const label = input.label?.trim()
    if (!label) throw new BadRequestException('label is required')
    const countryCode = input.countryCode?.trim().toUpperCase() || null

    switch (input.kind) {
      case 'PHONE': {
        if (!countryCode || !input.phone?.trim()) {
          throw new BadRequestException('phone and countryCode are required for a phone recipient')
        }
        const digits = toE164Digits(input.phone, countryCode)
        if (!digits) throw new BadRequestException('phone is not a valid number for the selected country')
        return {
          kind: BeneficiaryKind.PHONE,
          label,
          countryCode,
          phone: `+${digits}`,
          meterNumber: null,
          billerId: null,
          email: null,
        }
      }
      case 'METER': {
        const meterNumber = input.meterNumber?.replace(/\s+/g, '')
        if (!meterNumber || !input.billerId) {
          throw new BadRequestException('meterNumber and billerId are required for a meter recipient')
        }
        // The buyer's contact phone some billers ask for rides along unvalidated (it is only
        // ever used to prefill the form).
        return {
          kind: BeneficiaryKind.METER,
          label,
          countryCode,
          phone: input.phone?.trim() || null,
          meterNumber,
          billerId: input.billerId,
          email: null,
        }
      }
      case 'EMAIL': {
        const email = input.email?.trim().toLowerCase()
        if (!email) throw new BadRequestException('email is required for an email recipient')
        return {
          kind: BeneficiaryKind.EMAIL,
          label,
          countryCode,
          phone: null,
          meterNumber: null,
          billerId: null,
          email,
        }
      }
      default:
        throw new BadRequestException('kind must be PHONE, METER or EMAIL')
    }
  }
}
