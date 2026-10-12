import { BadRequestException, ConflictException, ForbiddenException, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { createHash } from 'crypto'
import { CustomerAuthService } from './customer-auth.service'
import { CustomerTokenService } from './customer-token.service'
import { CUSTOMER_AUDIENCE } from './customer-jwt'
import { createFakeCustomerPrisma, FakeCustomerPrisma } from './testing/fake-customer-prisma'

const SECRET = 'test-customer-secret'

const registration = () => ({
  email: '  Ada@Example.com ',
  password: 'correct horse',
  firstName: ' Ada ',
  lastName: 'Obi',
  phone: '+44 7860 980321',
  over18: true as const,
  acceptTerms: true as const,
})

function codeFromLastEmail(email: { sendVerificationCode: jest.Mock }): string {
  const calls = email.sendVerificationCode.mock.calls
  return calls[calls.length - 1][0].code
}

function codeErrorCode(error: unknown): string | undefined {
  return ((error as BadRequestException).getResponse() as { code?: string }).code
}

describe('CustomerAuthService', () => {
  let prisma: FakeCustomerPrisma
  let email: { sendVerificationCode: jest.Mock; sendPasswordReset: jest.Mock }
  let jwt: JwtService
  let service: CustomerAuthService

  beforeEach(() => {
    prisma = createFakeCustomerPrisma()
    email = {
      sendVerificationCode: jest.fn().mockResolvedValue(undefined),
      sendPasswordReset: jest.fn().mockResolvedValue(undefined),
    }
    jwt = new JwtService({ secret: SECRET, signOptions: { audience: CUSTOMER_AUDIENCE, expiresIn: '30d' } })
    const tokens = new CustomerTokenService(jwt, prisma as any)
    service = new CustomerAuthService(prisma as any, email as any, tokens)
  })

  async function registerAndVerify() {
    await service.register(registration())
    return service.verifyEmail('ada@example.com', codeFromLastEmail(email))
  }

  describe('register', () => {
    it('creates an unverified, normalised customer and emails a 6-digit code', async () => {
      const result = await service.register(registration())

      expect(result).toEqual({ status: 'verification_required', email: 'ada@example.com' })
      const [row] = prisma.customer.rows
      expect(row).toMatchObject({
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Obi',
        phone: '+447860980321',
        emailVerifiedAt: null,
      })
      expect(row.passwordHash).not.toContain('correct horse')
      expect(row.over18ConfirmedAt).toBeInstanceOf(Date)
      expect(row.termsAcceptedAt).toBeInstanceOf(Date)

      const code = codeFromLastEmail(email)
      expect(code).toMatch(/^\d{6}$/)
      // Only the hash is stored, never the code itself.
      const [token] = prisma.customerToken.rows
      expect(token.type).toBe('EMAIL_VERIFY')
      expect(token.tokenHash).not.toContain(code)
      expect(JSON.stringify(prisma.customerToken.rows)).not.toContain(code)
    })

    it('rejects a phone that is not a valid international number', async () => {
      await expect(service.register({ ...registration(), phone: '12345' })).rejects.toBeInstanceOf(BadRequestException)
    })

    it('409 EMAIL_TAKEN when a verified account owns the email', async () => {
      await registerAndVerify()
      const error = await service.register({ ...registration(), phone: '+447911123456' }).catch((e) => e)
      expect(error).toBeInstanceOf(ConflictException)
      expect(codeErrorCode(error)).toBe('EMAIL_TAKEN')
    })

    it('409 PHONE_TAKEN when a verified account owns the phone', async () => {
      await registerAndVerify()
      const error = await service.register({ ...registration(), email: 'other@example.com' }).catch((e) => e)
      expect(error).toBeInstanceOf(ConflictException)
      expect(codeErrorCode(error)).toBe('PHONE_TAKEN')
    })

    it('replaces an abandoned unverified registration instead of locking the email/phone forever', async () => {
      await service.register(registration())
      await service.register({ ...registration(), firstName: 'Adaeze' })

      expect(prisma.customer.rows).toHaveLength(1)
      expect(prisma.customer.rows[0].firstName).toBe('Adaeze')
    })
  })

  describe('check', () => {
    it('reports verified accounts only', async () => {
      await service.register(registration())
      expect(await service.check({ email: 'ada@example.com', phone: '+447860980321' })).toEqual({
        emailExists: false,
        phoneExists: false,
      })

      await service.verifyEmail('ada@example.com', codeFromLastEmail(email))
      expect(await service.check({ email: 'ADA@example.com ', phone: '+44 7860 980321' })).toEqual({
        emailExists: true,
        phoneExists: true,
      })
      expect(await service.check({ phone: 'garbage' })).toEqual({ emailExists: false, phoneExists: false })
    })
  })

  describe('verifyEmail', () => {
    it('verifies with the right code and returns a customer-audience token', async () => {
      const result = await registerAndVerify()

      expect(result.customer).toEqual({
        id: prisma.customer.rows[0].id,
        email: 'ada@example.com',
        firstName: 'Ada',
        lastName: 'Obi',
        phone: '+447860980321',
      })
      const payload = jwt.verify(result.token, { audience: CUSTOMER_AUDIENCE })
      expect(payload.sub).toBe(prisma.customer.rows[0].id)
      expect(prisma.customer.rows[0].emailVerifiedAt).toBeInstanceOf(Date)
      expect(prisma.customerToken.rows[0].usedAt).toBeInstanceOf(Date)
    })

    it('rejects a wrong code and counts the attempt', async () => {
      await service.register(registration())
      const right = codeFromLastEmail(email)
      const wrong = right === '000000' ? '111111' : '000000'

      const error = await service.verifyEmail('ada@example.com', wrong).catch((e) => e)
      expect(codeErrorCode(error)).toBe('INVALID_CODE')
      expect(prisma.customerToken.rows[0].attempts).toBe(1)
    })

    it('locks the code after 5 wrong attempts, even if the 6th is right', async () => {
      await service.register(registration())
      const right = codeFromLastEmail(email)
      const wrong = right === '000000' ? '111111' : '000000'
      for (let i = 0; i < 5; i++) {
        await service.verifyEmail('ada@example.com', wrong).catch(() => undefined)
      }

      const error = await service.verifyEmail('ada@example.com', right).catch((e) => e)
      expect(codeErrorCode(error)).toBe('TOO_MANY_ATTEMPTS')
    })

    it('rejects an expired code', async () => {
      await service.register(registration())
      prisma.customerToken.rows[0].expiresAt = new Date(Date.now() - 1000)

      const error = await service.verifyEmail('ada@example.com', codeFromLastEmail(email)).catch((e) => e)
      expect(codeErrorCode(error)).toBe('CODE_EXPIRED')
    })

    it('a code is single use', async () => {
      await service.register(registration())
      const code = codeFromLastEmail(email)
      await service.verifyEmail('ada@example.com', code)

      await expect(service.verifyEmail('ada@example.com', code)).rejects.toBeInstanceOf(BadRequestException)
    })
  })

  describe('resendVerification', () => {
    it('is silent for unknown emails and sends a fresh code otherwise, invalidating the old one', async () => {
      await expect(service.resendVerification('nobody@example.com')).resolves.toEqual({ ok: true })
      expect(email.sendVerificationCode).not.toHaveBeenCalled()

      await service.register(registration())
      const first = codeFromLastEmail(email)
      // Get past the resend cooldown.
      prisma.customerToken.rows[0].createdAt = new Date(Date.now() - 120_000)
      await service.resendVerification('ada@example.com')
      const second = codeFromLastEmail(email)

      expect(email.sendVerificationCode).toHaveBeenCalledTimes(2)
      expect(prisma.customerToken.rows[0].usedAt).toBeInstanceOf(Date)
      if (first !== second) {
        await expect(service.verifyEmail('ada@example.com', first)).rejects.toBeInstanceOf(BadRequestException)
      }
      await expect(service.verifyEmail('ada@example.com', second)).resolves.toHaveProperty('token')
    })

    it('does not send again inside the cooldown window', async () => {
      await service.register(registration())
      await service.resendVerification('ada@example.com')
      expect(email.sendVerificationCode).toHaveBeenCalledTimes(1)
    })
  })

  describe('login', () => {
    it('returns a token for a verified customer with the right password', async () => {
      await registerAndVerify()
      const result = await service.login('ADA@example.com', 'correct horse')
      expect(result.customer.email).toBe('ada@example.com')
      expect(jwt.verify(result.token, { audience: CUSTOMER_AUDIENCE }).sub).toBe(result.customer.id)
      expect(prisma.customer.rows[0].lastLoginAt).toBeInstanceOf(Date)
    })

    it('401 on a wrong password or unknown email, with the same error', async () => {
      await registerAndVerify()
      const wrong = await service.login('ada@example.com', 'nope nope').catch((e) => e)
      const unknown = await service.login('who@example.com', 'whatever1').catch((e) => e)
      expect(wrong).toBeInstanceOf(UnauthorizedException)
      expect(unknown).toBeInstanceOf(UnauthorizedException)
      expect(wrong.getResponse()).toEqual(unknown.getResponse())
    })

    it('403 EMAIL_NOT_VERIFIED for an unverified account and sends a fresh code', async () => {
      await service.register(registration())
      prisma.customerToken.rows[0].createdAt = new Date(Date.now() - 120_000)

      const error = await service.login('ada@example.com', 'correct horse').catch((e) => e)
      expect(error).toBeInstanceOf(ForbiddenException)
      expect(codeErrorCode(error)).toBe('EMAIL_NOT_VERIFIED')
      expect(email.sendVerificationCode).toHaveBeenCalledTimes(2)
    })

    it('does not reveal verification state to a wrong password', async () => {
      await service.register(registration())
      await expect(service.login('ada@example.com', 'wrong pass')).rejects.toBeInstanceOf(UnauthorizedException)
    })
  })

  describe('forgot / reset password', () => {
    it('forgot is silent for unknown emails', async () => {
      await expect(service.forgotPassword('nobody@example.com', 'en')).resolves.toEqual({ ok: true })
      expect(email.sendPasswordReset).not.toHaveBeenCalled()
    })

    it('emails a link token whose hash (only) is stored; reset sets the password once', async () => {
      await registerAndVerify()
      await service.forgotPassword('ada@example.com', 'fr-fr')

      const { token, locale } = email.sendPasswordReset.mock.calls[0][0]
      expect(locale).toBe('fr-fr')
      const stored = prisma.customerToken.rows.find((t) => t.type === 'PASSWORD_RESET')!
      expect(stored.tokenHash).toBe(createHash('sha256').update(token).digest('hex'))
      expect(stored.expiresAt.getTime() - Date.now()).toBeGreaterThan(59 * 60_000)
      expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(60 * 60_000)

      await expect(service.resetPassword(token, 'brand new pass')).resolves.toEqual({ ok: true })
      await expect(service.login('ada@example.com', 'brand new pass')).resolves.toHaveProperty('token')
      await expect(service.login('ada@example.com', 'correct horse')).rejects.toBeInstanceOf(UnauthorizedException)

      const reused = await service.resetPassword(token, 'another pass').catch((e) => e)
      expect(codeErrorCode(reused)).toBe('INVALID_TOKEN')
    })

    it('falls back to the default locale for an unknown one', async () => {
      await registerAndVerify()
      await service.forgotPassword('ada@example.com', '../evil')
      expect(email.sendPasswordReset.mock.calls[0][0].locale).toBe('en')
    })

    it('rejects an expired reset token', async () => {
      await registerAndVerify()
      await service.forgotPassword('ada@example.com', 'en')
      const { token } = email.sendPasswordReset.mock.calls[0][0]
      prisma.customerToken.rows.find((t) => t.type === 'PASSWORD_RESET')!.expiresAt = new Date(Date.now() - 1)

      const error = await service.resetPassword(token, 'brand new pass').catch((e) => e)
      expect(codeErrorCode(error)).toBe('INVALID_TOKEN')
    })

    it('a reset proves email ownership, so it also verifies an unverified account', async () => {
      await service.register(registration())
      await service.forgotPassword('ada@example.com', 'en')
      const { token } = email.sendPasswordReset.mock.calls[0][0]

      await service.resetPassword(token, 'brand new pass')
      expect(prisma.customer.rows[0].emailVerifiedAt).toBeInstanceOf(Date)
    })
  })
})
