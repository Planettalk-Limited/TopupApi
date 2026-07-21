import { Injectable } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service'
import { CreateClaimDto } from './dto/create-claim.dto'

@Injectable()
export class CreditbackService {
  constructor(private readonly prisma: PrismaService) {}

  async createClaim(dto: CreateClaimDto) {
    const claim = await this.prisma.creditbackClaim.create({
      data: {
        phone: dto.phone,
        countryCode: dto.countryCode,
        email: dto.email,
        transactionValue: dto.transactionValue,
        transactionCurrency: dto.transactionCurrency.toUpperCase(),
        transactionId: dto.transactionId,
        locale: dto.locale,
      },
      select: { id: true, createdAt: true },
    })

    return claim
  }
}
