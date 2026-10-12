// Customer (buyer) accounts — email + password, verified by a 6-digit code sent by email
// so the buyer never leaves checkout. No SMS OTP (webmart review D.2).
//
// Secrets at rest: passwords are bcrypt; verification codes and reset tokens are stored
// only as SHA-256 hashes (CustomerToken.tokenHash). Endpoints that take an email and act
// on it (resend, forgot) answer the same way whether or not the account exists.
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common'
import { CustomerTokenType } from '@prisma/client'
import * as bcrypt from 'bcrypt'
import { createHash, randomBytes, randomInt } from 'crypto'
import { parsePhoneNumberFromString } from 'libphonenumber-js'
import { CustomerEmailService } from '../common/customer-email.service'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedCustomer, toAuthenticatedCustomer } from './customer-jwt'
import { CustomerTokenService } from './customer-token.service'

export const VERIFY_CODE_TTL_MINUTES = 15
export const VERIFY_CODE_MAX_ATTEMPTS = 5
export const RESET_TOKEN_TTL_MINUTES = 60
/** Minimum gap between verification emails to one account (resend / login re-sends). */
export const VERIFY_RESEND_COOLDOWN_MS = 60_000
const BCRYPT_COST = 12

/** Storefront locales (TopupApp src/i18n/locales.ts) — anything else falls back to 'en'. */
export const SITE_LOCALES = ['en', 'en-gb', 'en-ca', 'en-us', 'en-ie', 'fr-fr'] as const

// Compared against when the email is unknown, so login takes about as long either way.
const DUMMY_HASH = bcrypt.hashSync('timing-equaliser-not-a-password', BCRYPT_COST)

export interface RegisterInput {
  email: string
  password: string
  firstName: string
  lastName: string
  phone: string
  over18: true
  acceptTerms: true
}

export interface AuthResult {
  token: string
  customer: AuthenticatedCustomer
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

/** E.164 (`+447700900000`) or null. Account phones must be entered with their country code. */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const parsed = parsePhoneNumberFromString(trimmed.startsWith('+') ? trimmed : `+${trimmed.replace(/^00/, '')}`)
  return parsed?.isValid() ? parsed.number : null
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Codes are only 6 digits, so salt the hash with the customer id (no shared lookup table). */
function hashCode(customerId: string, code: string): string {
  return sha256(`${customerId}:${code}`)
}

function codeError(status: 'bad' | 'conflict' | 'forbidden' | 'unauthorized', code: string, message: string) {
  const body = { code, message }
  switch (status) {
    case 'conflict':
      return new ConflictException(body)
    case 'forbidden':
      return new ForbiddenException(body)
    case 'unauthorized':
      return new UnauthorizedException(body)
    default:
      return new BadRequestException(body)
  }
}

@Injectable()
export class CustomerAuthService {
  private readonly logger = new Logger(CustomerAuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: CustomerEmailService,
    private readonly tokens: CustomerTokenService,
  ) {}

  /**
   * Lets the sign-up modal switch to "Log in" for a known email and warn about a phone
   * already tied to an account. Only VERIFIED accounts count: an abandoned, unverified
   * registration is replaced by the next sign-up (see register).
   */
  async check(input: { email?: string; phone?: string }): Promise<{ emailExists: boolean; phoneExists: boolean }> {
    const email = input.email ? normalizeEmail(input.email) : null
    const phone = normalizePhone(input.phone)

    const [byEmail, byPhone] = await Promise.all([
      email ? this.prisma.customer.findUnique({ where: { email } }) : null,
      phone ? this.prisma.customer.findUnique({ where: { phone } }) : null,
    ])
    return { emailExists: !!byEmail?.emailVerifiedAt, phoneExists: !!byPhone?.emailVerifiedAt }
  }

  async register(input: RegisterInput): Promise<{ status: 'verification_required'; email: string }> {
    const email = normalizeEmail(input.email)
    const phone = normalizePhone(input.phone)
    if (!phone) {
      throw codeError('bad', 'INVALID_PHONE', 'Enter a valid mobile number including the country code')
    }

    const [byEmail, byPhone] = await Promise.all([
      this.prisma.customer.findUnique({ where: { email } }),
      this.prisma.customer.findUnique({ where: { phone } }),
    ])
    if (byEmail?.emailVerifiedAt) {
      throw codeError('conflict', 'EMAIL_TAKEN', 'An account with this email already exists')
    }
    if (byPhone?.emailVerifiedAt) {
      throw codeError('conflict', 'PHONE_TAKEN', 'This mobile number is already tied to an account')
    }

    const passwordHash = await bcrypt.hash(input.password, BCRYPT_COST)
    const now = new Date()

    // Unverified rows holding this email/phone are abandoned sign-ups (nobody proved they
    // own that email) — release them rather than lock the email/phone out for good.
    const stale = [...new Set([byEmail?.id, byPhone?.id].filter((id): id is string => !!id))]

    let customer
    try {
      customer = await this.prisma.$transaction(async (tx) => {
        if (stale.length > 0) {
          await tx.customer.deleteMany({ where: { id: { in: stale }, emailVerifiedAt: null } })
        }
        return tx.customer.create({
          data: {
            email,
            phone,
            passwordHash,
            firstName: input.firstName.trim(),
            lastName: input.lastName.trim(),
            over18ConfirmedAt: now,
            termsAcceptedAt: now,
          },
        })
      })
    } catch (error) {
      // Lost a race with a concurrent sign-up for the same email/phone.
      if ((error as { code?: string })?.code === 'P2002') {
        const target = String((error as { meta?: { target?: unknown } }).meta?.target ?? '')
        throw target.includes('phone')
          ? codeError('conflict', 'PHONE_TAKEN', 'This mobile number is already tied to an account')
          : codeError('conflict', 'EMAIL_TAKEN', 'An account with this email already exists')
      }
      throw error
    }

    await this.issueVerificationCode(customer)
    return { status: 'verification_required', email }
  }

  async verifyEmail(rawEmail: string, code: string): Promise<AuthResult> {
    const invalid = () => codeError('bad', 'INVALID_CODE', 'That code is not right. Check the email and try again.')

    const customer = await this.prisma.customer.findUnique({ where: { email: normalizeEmail(rawEmail) } })
    if (!customer) throw invalid()

    const token = await this.prisma.customerToken.findFirst({
      where: { customerId: customer.id, type: CustomerTokenType.EMAIL_VERIFY, usedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (!token) throw invalid()
    if (token.expiresAt.getTime() <= Date.now()) {
      throw codeError('bad', 'CODE_EXPIRED', 'That code has expired. Request a new one.')
    }
    if (token.attempts >= VERIFY_CODE_MAX_ATTEMPTS) {
      throw codeError('bad', 'TOO_MANY_ATTEMPTS', 'Too many attempts. Request a new code.')
    }

    if (hashCode(customer.id, String(code).trim()) !== token.tokenHash) {
      await this.prisma.customerToken.update({ where: { id: token.id }, data: { attempts: { increment: 1 } } })
      throw invalid()
    }

    const now = new Date()
    // Guarded single use: a concurrent second submit of the same code matches 0 rows.
    const used = await this.prisma.customerToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    })
    if (used.count !== 1) throw invalid()

    const verified = await this.prisma.customer.update({
      where: { id: customer.id },
      data: { emailVerifiedAt: customer.emailVerifiedAt ?? now, lastLoginAt: now },
    })
    return this.session(verified)
  }

  async resendVerification(rawEmail: string): Promise<{ ok: true }> {
    const customer = await this.prisma.customer.findUnique({ where: { email: normalizeEmail(rawEmail) } })
    if (customer && !customer.emailVerifiedAt) {
      await this.issueVerificationCode(customer)
    }
    return { ok: true }
  }

  async login(rawEmail: string, password: string): Promise<AuthResult> {
    const customer = await this.prisma.customer.findUnique({ where: { email: normalizeEmail(rawEmail) } })
    const ok = await bcrypt.compare(password, customer?.passwordHash ?? DUMMY_HASH)
    if (!customer || !ok) {
      throw codeError('unauthorized', 'INVALID_CREDENTIALS', 'Incorrect email or password')
    }

    if (!customer.emailVerifiedAt) {
      await this.issueVerificationCode(customer)
      throw codeError('forbidden', 'EMAIL_NOT_VERIFIED', 'Verify your email to continue. We have sent you a new code.')
    }

    const updated = await this.prisma.customer.update({
      where: { id: customer.id },
      data: { lastLoginAt: new Date() },
    })
    return this.session(updated)
  }

  async forgotPassword(rawEmail: string, rawLocale: string | undefined): Promise<{ ok: true }> {
    const customer = await this.prisma.customer.findUnique({ where: { email: normalizeEmail(rawEmail) } })
    if (!customer) return { ok: true }

    const locale = (SITE_LOCALES as readonly string[]).includes(String(rawLocale ?? '').toLowerCase())
      ? String(rawLocale).toLowerCase()
      : 'en'

    const raw = randomBytes(32).toString('base64url')
    // One live reset link at a time: a new request retires older ones.
    await this.prisma.customerToken.updateMany({
      where: { customerId: customer.id, type: CustomerTokenType.PASSWORD_RESET, usedAt: null },
      data: { usedAt: new Date() },
    })
    await this.prisma.customerToken.create({
      data: {
        customerId: customer.id,
        type: CustomerTokenType.PASSWORD_RESET,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    })

    void this.email
      .sendPasswordReset({ to: customer.email, firstName: customer.firstName, token: raw, locale })
      .catch((err) => this.logger.error('Password reset email dispatch failed', err as Error))
    return { ok: true }
  }

  async resetPassword(rawToken: string, password: string): Promise<{ ok: true }> {
    const invalid = () => codeError('bad', 'INVALID_TOKEN', 'This reset link is invalid or has expired. Request a new one.')
    if (typeof rawToken !== 'string' || !rawToken.trim()) throw invalid()

    const token = await this.prisma.customerToken.findFirst({
      where: { tokenHash: sha256(rawToken.trim()), type: CustomerTokenType.PASSWORD_RESET, usedAt: null },
    })
    if (!token || token.expiresAt.getTime() <= Date.now()) throw invalid()

    const now = new Date()
    const used = await this.prisma.customerToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: now },
    })
    if (used.count !== 1) throw invalid()

    const customer = await this.prisma.customer.findUnique({ where: { id: token.customerId } })
    if (!customer) throw invalid()

    await this.prisma.customer.update({
      where: { id: customer.id },
      data: {
        passwordHash: await bcrypt.hash(password, BCRYPT_COST),
        // The link was delivered to this inbox, which proves ownership of the address.
        emailVerifiedAt: customer.emailVerifiedAt ?? now,
      },
    })
    return { ok: true }
  }

  private async session(row: Parameters<typeof toAuthenticatedCustomer>[0]): Promise<AuthResult> {
    const customer = toAuthenticatedCustomer(row)
    return { token: await this.tokens.sign(customer), customer }
  }

  /**
   * Retire any outstanding code and email a fresh one — unless one went out within the
   * cooldown, so resend/login cannot be used to flood someone's inbox.
   */
  private async issueVerificationCode(customer: { id: string; email: string; firstName: string }): Promise<void> {
    const latest = await this.prisma.customerToken.findFirst({
      where: { customerId: customer.id, type: CustomerTokenType.EMAIL_VERIFY, usedAt: null },
      orderBy: { createdAt: 'desc' },
    })
    if (latest && Date.now() - latest.createdAt.getTime() < VERIFY_RESEND_COOLDOWN_MS) {
      return
    }

    await this.prisma.customerToken.updateMany({
      where: { customerId: customer.id, type: CustomerTokenType.EMAIL_VERIFY, usedAt: null },
      data: { usedAt: new Date() },
    })

    const code = String(randomInt(0, 1_000_000)).padStart(6, '0')
    await this.prisma.customerToken.create({
      data: {
        customerId: customer.id,
        type: CustomerTokenType.EMAIL_VERIFY,
        tokenHash: hashCode(customer.id, code),
        expiresAt: new Date(Date.now() + VERIFY_CODE_TTL_MINUTES * 60_000),
      },
    })

    void this.email
      .sendVerificationCode({
        to: customer.email,
        firstName: customer.firstName,
        code,
        expiresInMinutes: VERIFY_CODE_TTL_MINUTES,
      })
      .catch((err) => this.logger.error('Verification email dispatch failed', err as Error))
  }
}
