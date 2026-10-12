import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator'

export const PROMO_PRODUCT_TYPES = ['topup', 'data', 'giftcard', 'utility', 'healthcare'] as const

export class CreatePromoCodeDto {
  /** Letters, digits, '-' and '_'; stored upper-cased. */
  @Matches(/^[A-Za-z0-9_-]{3,40}$/, { message: 'code must be 3-40 letters, digits, - or _' })
  code!: string

  @IsOptional() @IsString() @MaxLength(500) description?: string

  @IsIn(['PERCENT', 'FIXED_GBP']) discountType!: 'PERCENT' | 'FIXED_GBP'

  /** PERCENT: 0-100. FIXED_GBP: amount in GBP. */
  @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) value!: number

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) maxDiscountGbp?: number | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) minOrderGbp?: number | null

  /** Empty / omitted = every product type. */
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsIn(PROMO_PRODUCT_TYPES, { each: true }) productTypes?: string[]

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startsAt?: string | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endsAt?: string | null

  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) maxRedemptions?: number | null
  @IsOptional() @IsInt() @Min(1) perCustomerLimit?: number
  @IsOptional() @IsBoolean() active?: boolean
}

/** Every field but `code` (immutable — redemptions and receipts refer to it). */
export class UpdatePromoCodeDto {
  @IsOptional() @IsString() @MaxLength(500) description?: string
  @IsOptional() @IsIn(['PERCENT', 'FIXED_GBP']) discountType?: 'PERCENT' | 'FIXED_GBP'
  @IsOptional() @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) value?: number
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0.01) maxDiscountGbp?: number | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) minOrderGbp?: number | null
  @IsOptional() @IsArray() @ArrayMaxSize(5) @IsIn(PROMO_PRODUCT_TYPES, { each: true }) productTypes?: string[]
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() startsAt?: string | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsDateString() endsAt?: string | null
  @IsOptional() @ValidateIf((_, v) => v !== null) @IsInt() @Min(1) maxRedemptions?: number | null
  @IsOptional() @IsInt() @Min(1) perCustomerLimit?: number
  @IsOptional() @IsBoolean() active?: boolean
}
