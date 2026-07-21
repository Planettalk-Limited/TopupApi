import { Type } from 'class-transformer'
import { IsEnum, IsInt, IsOptional, IsString, Max, Min } from 'class-validator'
import { CreditbackClaimStatus, CreditbackCountry } from '@prisma/client'

export class ListCreditbackDto {
  @IsOptional()
  @IsEnum(CreditbackClaimStatus)
  status?: CreditbackClaimStatus

  @IsOptional()
  @IsEnum(CreditbackCountry)
  countryCode?: CreditbackCountry

  @IsOptional()
  @IsString()
  search?: string

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 25
}
