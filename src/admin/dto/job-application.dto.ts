import { IsIn } from 'class-validator'
import { ApplicationStatus } from '@prisma/client'

export class SetApplicationStatusDto {
  @IsIn([ApplicationStatus.NEW, ApplicationStatus.SHORTLISTED, ApplicationStatus.REJECTED, ApplicationStatus.HIRED])
  status!: ApplicationStatus
}
