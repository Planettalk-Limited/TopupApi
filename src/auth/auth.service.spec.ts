import { BadRequestException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcrypt'
import { createHash, randomUUID } from 'crypto'
import { AuthService } from './auth.service'

type Row = Record<string, any>

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

// Just the slice of PrismaClient the admin reset flow touches.
function createFakePrisma() {
  const admins: Row[] = []
  const tokens: Row[] = []
  const audit: Row[] = []
  const matches = (row: Row, where: Row = {}) => Object.entries(where).every(([k, v]) => (v === null ? row[k] == null : row[k] === v))

  return {
    admins,
    tokens,
    audit,
    adminUser: {
      findUnique: jest.fn(async ({ where }: { where: Row }) => admins.find((r) => matches(r, where)) ?? null),
      update: jest.fn(async ({ where, data }: { where: Row; data: Row }) => Object.assign(admins.find((r) => matches(r, where))!, data)),
    },
    adminPasswordResetToken: {
      findFirst: jest.fn(async ({ where }: { where: Row }) => tokens.find((r) => matches(r, where)) ?? null),
      create: jest.fn(async ({ data }: { data: Row }) => {
        const row = { id: randomUUID(), usedAt: null, createdAt: new Date(), ...data }
        tokens.push(row)
        return row
      }),
      updateMany: jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const hit = tokens.filter((r) => matches(r, where))
        hit.forEach((r) => Object.assign(r, data))
        return { count: hit.length }
      }),
    },
    adminAuditLog: {
      create: jest.fn(async ({ data }: { data: Row }) => {
        audit.push(data)
        return data
      }),
    },
  }
}

describe('AuthService admin password reset', () => {
  let prisma: ReturnType<typeof createFakePrisma>
  let email: { sendAdminPasswordReset: jest.Mock }
  let service: AuthService

  beforeEach(async () => {
    prisma = createFakePrisma()
    prisma.admins.push({
      id: 'admin-1',
      email: 'ops@planettalk.com',
      name: 'Ops',
      role: 'ADMIN',
      active: true,
      passwordHash: await bcrypt.hash('old password', 4),
    })
    email = { sendAdminPasswordReset: jest.fn().mockResolvedValue(undefined) }
    service = new AuthService(prisma as any, new JwtService({ secret: 'test' }), email as any)
  })

  const lastToken = () => email.sendAdminPasswordReset.mock.calls.at(-1)[0].token as string

  it('is silent for unknown and inactive admins', async () => {
    await expect(service.forgotPassword('nobody@planettalk.com')).resolves.toEqual({ ok: true })
    prisma.admins[0].active = false
    await expect(service.forgotPassword('ops@planettalk.com')).resolves.toEqual({ ok: true })
    expect(email.sendAdminPasswordReset).not.toHaveBeenCalled()
    expect(prisma.tokens).toHaveLength(0)
  })

  it('emails a token whose hash (only) is stored, and audits the request', async () => {
    await service.forgotPassword('  OPS@planettalk.com ')

    expect(email.sendAdminPasswordReset).toHaveBeenCalledWith(
      expect.objectContaining({ to: 'ops@planettalk.com', name: 'Ops' }),
    )
    const raw = lastToken()
    expect(prisma.tokens).toHaveLength(1)
    expect(prisma.tokens[0].tokenHash).toBe(sha256(raw))
    expect(JSON.stringify(prisma.tokens)).not.toContain(raw)
    expect(prisma.audit).toContainEqual(expect.objectContaining({ adminId: 'admin-1', action: 'admin_forgot_password' }))
  })

  it('resets the password once; the link cannot be reused', async () => {
    await service.forgotPassword('ops@planettalk.com')
    const raw = lastToken()

    await expect(service.resetPassword(raw, 'brand new password')).resolves.toEqual({ ok: true })
    expect(await bcrypt.compare('brand new password', prisma.admins[0].passwordHash)).toBe(true)
    expect(prisma.audit).toContainEqual(expect.objectContaining({ action: 'admin_reset_password_self' }))

    await expect(service.resetPassword(raw, 'another password')).rejects.toBeInstanceOf(BadRequestException)
  })

  it('a new request retires the previous link', async () => {
    await service.forgotPassword('ops@planettalk.com')
    const first = lastToken()
    await service.forgotPassword('ops@planettalk.com')

    await expect(service.resetPassword(first, 'brand new password')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.resetPassword(lastToken(), 'brand new password')).resolves.toEqual({ ok: true })
  })

  it('rejects expired, unknown and blank tokens', async () => {
    await service.forgotPassword('ops@planettalk.com')
    prisma.tokens[0].expiresAt = new Date(Date.now() - 1000)

    await expect(service.resetPassword(lastToken(), 'brand new password')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.resetPassword('not-a-token', 'brand new password')).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.resetPassword('  ', 'brand new password')).rejects.toBeInstanceOf(BadRequestException)
  })

  it('refuses to reset a deactivated admin even with a live link', async () => {
    await service.forgotPassword('ops@planettalk.com')
    prisma.admins[0].active = false

    await expect(service.resetPassword(lastToken(), 'brand new password')).rejects.toBeInstanceOf(BadRequestException)
    expect(await bcrypt.compare('old password', prisma.admins[0].passwordHash)).toBe(true)
  })
})
