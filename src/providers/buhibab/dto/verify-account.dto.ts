import { Type } from 'class-transformer'
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator'
import type { MeterType } from '../planettalk.service'

export class VerifyAccountDto {
  @Type(() => Number)
  @IsInt()
  @Min(1)
  productId!: number

  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  billersCode!: string

  /** Electricity only — Buhibab accepts lowercase prepaid|postpaid. */
  @IsOptional()
  @IsIn(['prepaid', 'postpaid'])
  meterType?: MeterType
}
