import {
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator'
import { CreditbackCountry } from '@prisma/client'

// Kept in sync manually with CREDITBACK_ELIGIBLE_COUNTRIES in TopupApp's
// src/lib/countries.ts — this is the server-side source of truth; a
// tampered/direct API call can't submit a country outside this list even if
// the client-side restriction is bypassed.
export const ELIGIBLE_COUNTRY_CODES: CreditbackCountry[] = ['GB', 'US', 'CA', 'FR', 'IE']

export class CreateClaimDto {
  @IsString()
  @Matches(/^\d{5,12}$/, { message: 'phone must be 5-12 digits, no symbols or spaces' })
  phone!: string

  @IsIn(ELIGIBLE_COUNTRY_CODES, {
    message: `countryCode must be one of ${ELIGIBLE_COUNTRY_CODES.join(', ')}`,
  })
  countryCode!: CreditbackCountry

  @IsEmail()
  @MaxLength(254)
  email!: string

  @IsNumber()
  @Min(0)
  @Max(1_000_000)
  transactionValue!: number

  @IsString()
  @MaxLength(10)
  transactionCurrency!: string

  @IsOptional()
  @IsString()
  @MaxLength(255)
  transactionId?: string

  @IsOptional()
  @IsString()
  @MaxLength(10)
  locale?: string
}
