import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator'
import { JobStatus } from '@prisma/client'

export class CreateJobPostingDto {
  @IsString() @MaxLength(200) title!: string
  @IsString() @MaxLength(100) department!: string
  @IsString() @MaxLength(200) location!: string
  @IsString() @MaxLength(100) employmentType!: string
  @IsString() @MaxLength(20_000) description!: string
}

export class UpdateJobPostingDto {
  @IsOptional() @IsString() @MaxLength(200) title?: string
  @IsOptional() @IsString() @MaxLength(100) department?: string
  @IsOptional() @IsString() @MaxLength(200) location?: string
  @IsOptional() @IsString() @MaxLength(100) employmentType?: string
  @IsOptional() @IsString() @MaxLength(20_000) description?: string
  @IsOptional() @IsIn([JobStatus.OPEN, JobStatus.CLOSED]) status?: JobStatus
}
