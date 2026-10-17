import { IsEmail, IsNotEmpty, IsString, MaxLength, MinLength } from 'class-validator'

export class AdminForgotPasswordDto {
  @IsEmail()
  @MaxLength(254)
  email!: string
}

export class AdminResetPasswordDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  token!: string

  // Same floor as a superadmin-set password (ResetAdminPasswordDto).
  @IsString()
  @MinLength(8)
  @MaxLength(200)
  password!: string
}
