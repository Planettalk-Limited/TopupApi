import { IsEnum } from 'class-validator'
import { CreditbackClaimStatus } from '@prisma/client'

export class UpdateCreditbackStatusDto {
  @IsEnum(CreditbackClaimStatus)
  status!: CreditbackClaimStatus
}
