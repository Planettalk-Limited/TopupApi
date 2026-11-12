import { Type } from 'class-transformer'
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator'
import type { GiftEntitlementStatus, GiftSubmissionStatus } from '@prisma/client'
import { SUBMISSION_STATUSES } from '../gift-status'

/**
 * Landing-page submission. Shapes only — the semantic rules (E.164, +234, consents,
 * email format) live in gift-submission.ts so they are unit-tested and shared.
 */
export class SubmitGiftDto {
  @IsString() @MaxLength(200) senderName!: string
  @IsString() @MaxLength(254) senderEmail!: string
  @IsString() @MaxLength(32) senderPhone!: string
  @IsString() @MaxLength(200) recipientName!: string
  @IsString() @MaxLength(32) recipientPhone!: string
  @IsOptional() @IsString() @MaxLength(254) recipientEmail?: string
  @IsOptional() @IsString() @MaxLength(40) relationship?: string
  @IsOptional() @IsString() @MaxLength(40) preferredContact?: string
  @IsBoolean() declarationAccepted!: boolean
  @IsBoolean() termsAccepted!: boolean
  @IsString() @MaxLength(64) termsVersion!: string
}

export class ListGiftSubmissionsDto {
  @IsOptional() @IsIn(SUBMISSION_STATUSES) status?: GiftSubmissionStatus
  @IsOptional() @IsIn(['true', 'false']) flagged?: 'true' | 'false'
  @IsOptional() @IsString() @MaxLength(64) flag?: string
  @IsOptional() @IsIn(['me', 'none']) assigned?: 'me' | 'none'
  @IsOptional() @IsString() @MaxLength(120) q?: string
  @IsOptional() @IsDateString() from?: string
  @IsOptional() @IsDateString() to?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number
}

export class ListGiftEntitlementsDto {
  @IsOptional() @IsIn(['LINK_ISSUED', 'SUBMITTED', 'EXPIRED', 'CANCELLED']) status?: GiftEntitlementStatus
  @IsOptional() @IsString() @MaxLength(120) q?: string
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page?: number
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(200) pageSize?: number
}

export class TransitionGiftDto {
  @IsIn(SUBMISSION_STATUSES) status!: GiftSubmissionStatus
  @IsOptional() @IsString() @MaxLength(64) reasonCode?: string
  @IsOptional() @IsString() @MaxLength(2000) note?: string
}

export const CONTACT_OUTCOMES = ['reached', 'no_answer', 'voicemail', 'wrong_number', 'declined', 'callback_requested', 'other'] as const

export class ContactAttemptDto {
  @IsIn(['sms', 'phone_call', 'whatsapp', 'email']) channel!: string
  @IsIn(CONTACT_OUTCOMES) outcome!: string
  @IsOptional() @IsString() @MaxLength(2000) note?: string
}

export class GiftNoteDto {
  @IsString() @MinLength(1) @MaxLength(2000) note!: string
}

export class AssignGiftDto {
  /** An admin id, 'me', or null to unassign. */
  @ValidateIf((_, v) => v !== null && v !== 'me') @IsUUID() adminId!: string | null
}

export class IssueGiftVoucherDto {
  /** buhibab voucher product; defaults to GIFT_CAMPAIGN_VOUCHER_PRODUCT_ID. */
  @IsOptional() @IsInt() @Min(1) productId?: number
  /** Whole naira; defaults to GIFT_CAMPAIGN_VOUCHER_AMOUNT_NGN. */
  @IsOptional() @IsInt() @Min(1) amountNgn?: number
}
