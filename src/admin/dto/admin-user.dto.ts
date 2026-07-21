import { IsBoolean, IsEmail, IsEnum, IsOptional, IsString, MinLength } from 'class-validator'
import { AdminRole } from '@prisma/client'

export class CreateAdminUserDto {
  @IsEmail()
  email!: string

  @IsString()
  @MinLength(2)
  name!: string

  @IsString()
  @MinLength(8)
  password!: string

  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole
}

export class UpdateAdminUserDto {
  @IsOptional()
  @IsString()
  @MinLength(2)
  name?: string

  @IsOptional()
  @IsEnum(AdminRole)
  role?: AdminRole

  @IsOptional()
  @IsBoolean()
  active?: boolean
}

export class ResetAdminPasswordDto {
  @IsString()
  @MinLength(8)
  password!: string
}
