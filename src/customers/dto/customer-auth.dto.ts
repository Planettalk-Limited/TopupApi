import {
  Equals,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator'

export const PASSWORD_MIN = 8
// bcrypt only reads the first 72 bytes; bounded so a huge body cannot cost a slow hash.
const PASSWORD_MAX = 128

export class CheckCustomerDto {
  @IsOptional() @IsEmail() @MaxLength(254) email?: string
  @IsOptional() @IsString() @MaxLength(32) phone?: string
}

export class RegisterCustomerDto {
  @IsEmail() @MaxLength(254) email!: string

  @IsString()
  @MinLength(PASSWORD_MIN, { message: `password must be at least ${PASSWORD_MIN} characters` })
  @MaxLength(PASSWORD_MAX)
  password!: string

  @IsString() @IsNotEmpty() @MaxLength(100) firstName!: string
  @IsString() @IsNotEmpty() @MaxLength(100) lastName!: string

  /** E.164, e.g. +447700900000 (a leading '+' is assumed if missing). */
  @IsString() @IsNotEmpty() @MaxLength(32) phone!: string

  @Equals(true, { message: 'You must confirm you are over 18' }) over18!: true
  @Equals(true, { message: 'You must accept the Terms and Privacy Policy' }) acceptTerms!: true
}

export class VerifyEmailDto {
  @IsEmail() @MaxLength(254) email!: string
  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' }) code!: string
}

export class EmailOnlyDto {
  @IsEmail() @MaxLength(254) email!: string
}

export class CustomerLoginDto {
  @IsEmail() @MaxLength(254) email!: string
  @IsString() @MinLength(1) @MaxLength(PASSWORD_MAX) password!: string
}

export class ForgotPasswordDto {
  @IsEmail() @MaxLength(254) email!: string
  @IsOptional() @IsString() @MaxLength(10) locale?: string
}

export class ResetPasswordDto {
  @IsString() @IsNotEmpty() @MaxLength(200) token!: string

  @IsString()
  @MinLength(PASSWORD_MIN, { message: `password must be at least ${PASSWORD_MIN} characters` })
  @MaxLength(PASSWORD_MAX)
  password!: string
}

export class CreateBeneficiaryDto {
  @IsIn(['PHONE', 'METER', 'EMAIL']) kind!: 'PHONE' | 'METER' | 'EMAIL'
  @IsString() @IsNotEmpty() @MaxLength(60) label!: string
  @IsOptional() @Matches(/^[A-Za-z]{2}$/, { message: 'countryCode must be ISO-3166 alpha-2' }) countryCode?: string
  @IsOptional() @IsString() @MaxLength(32) phone?: string
  @IsOptional() @IsString() @MaxLength(64) meterNumber?: string
  @IsOptional() @IsInt() @Min(1) billerId?: number
  @IsOptional() @IsEmail() @MaxLength(254) email?: string
}
