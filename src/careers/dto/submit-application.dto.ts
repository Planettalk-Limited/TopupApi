import { IsEmail, IsIn, IsOptional, IsString, MaxLength, Matches } from 'class-validator'

export const YEARS_OF_EXPERIENCE = ['Less than 1 year', '1–2 years', '3–5 years', '6–9 years', '10+ years']
export const WORK_PREFERENCES = ['Remote', 'Hybrid', 'On-site']
export const RIGHT_TO_WORK = ['Yes', 'No', 'Need sponsorship']

const URL_RE = /^https?:\/\//i

export class SubmitApplicationDto {
  @IsString() @MaxLength(100) firstName!: string
  @IsString() @MaxLength(100) lastName!: string
  @IsEmail() @MaxLength(254) email!: string
  @IsOptional() @IsString() @MaxLength(30) phone?: string
  @IsOptional() @IsString() @Matches(URL_RE, { message: 'linkedin must be an http(s) URL' }) @MaxLength(500) linkedin?: string
  @IsOptional() @IsString() @Matches(URL_RE, { message: 'portfolio must be an http(s) URL' }) @MaxLength(500) portfolio?: string
  @IsOptional() @IsString() @MaxLength(200) currentTitle?: string
  @IsIn(YEARS_OF_EXPERIENCE) yearsExperience!: string
  @IsString() @MaxLength(200) preferredLocation!: string
  @IsIn(WORK_PREFERENCES) workPreference!: string
  @IsIn(RIGHT_TO_WORK) rightToWork!: string
  @IsString() @MaxLength(5000) whyJoin!: string
}
