import { BadRequestException, Injectable, Logger, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcrypt'
import { createHash, randomBytes } from 'crypto'
import { CustomerEmailService } from '../common/customer-email.service'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin, JwtPayload } from './jwt-payload.interface'

export const ADMIN_RESET_TOKEN_TTL_MINUTES = 60
const SALT_ROUNDS = 12

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name)

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
    private readonly email: CustomerEmailService,
  ) {}

  /**
   * Email a single-use reset link. Answers the same whether or not the address is an
   * active admin, so the endpoint can't be used to discover admin accounts.
   */
  async forgotPassword(email: string): Promise<{ ok: true }> {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.trim().toLowerCase() } })
    if (!admin || !admin.active) return { ok: true }

    const raw = randomBytes(32).toString('base64url')
    // One live reset link at a time: a new request retires older ones.
    await this.prisma.adminPasswordResetToken.updateMany({
      where: { adminId: admin.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    await this.prisma.adminPasswordResetToken.create({
      data: {
        adminId: admin.id,
        tokenHash: sha256(raw),
        expiresAt: new Date(Date.now() + ADMIN_RESET_TOKEN_TTL_MINUTES * 60_000),
      },
    })
    await this.prisma.adminAuditLog.create({
      data: { adminId: admin.id, action: 'admin_forgot_password', target: admin.id, result: admin.email },
    })

    void this.email
      .sendAdminPasswordReset({ to: admin.email, name: admin.name, token: raw })
      .catch((err) => this.logger.error('Admin password reset email dispatch failed', err as Error))
    return { ok: true }
  }

  /** Spend a reset link: set the new password and burn the token. */
  async resetPassword(rawToken: string, password: string): Promise<{ ok: true }> {
    const invalid = () => new BadRequestException('This reset link is invalid or has expired. Request a new one.')
    if (typeof rawToken !== 'string' || !rawToken.trim()) throw invalid()

    const token = await this.prisma.adminPasswordResetToken.findFirst({
      where: { tokenHash: sha256(rawToken.trim()), usedAt: null },
    })
    if (!token || token.expiresAt.getTime() <= Date.now()) throw invalid()

    // Claim the token atomically so two concurrent submits can't both use it.
    const used = await this.prisma.adminPasswordResetToken.updateMany({
      where: { id: token.id, usedAt: null },
      data: { usedAt: new Date() },
    })
    if (used.count !== 1) throw invalid()

    const admin = await this.prisma.adminUser.findUnique({ where: { id: token.adminId } })
    if (!admin || !admin.active) throw invalid()

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { passwordHash: await bcrypt.hash(password, SALT_ROUNDS) },
    })
    await this.prisma.adminAuditLog.create({
      data: { adminId: admin.id, action: 'admin_reset_password_self', target: admin.id, result: admin.email },
    })
    return { ok: true }
  }

  /** Validate email+password, return a signed JWT + the admin profile. */
  async login(email: string, password: string) {
    const admin = await this.prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } })
    // Compare against the stored hash even when the user is missing/inactive
    // is not worth the constant-time effort here; a generic error is enough.
    if (!admin || !admin.active) {
      throw new UnauthorizedException('Invalid credentials')
    }

    const ok = await bcrypt.compare(password, admin.passwordHash)
    if (!ok) {
      throw new UnauthorizedException('Invalid credentials')
    }

    await this.prisma.adminUser.update({
      where: { id: admin.id },
      data: { lastLoginAt: new Date() },
    })

    const payload: JwtPayload = { sub: admin.id, email: admin.email, role: admin.role }
    return {
      accessToken: await this.jwt.signAsync(payload),
      admin: {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        role: admin.role,
      },
    }
  }

  /** Called by JwtStrategy on every authenticated request. */
  async validateJwtPayload(payload: JwtPayload): Promise<AuthenticatedAdmin> {
    const admin = await this.prisma.adminUser.findUnique({ where: { id: payload.sub } })
    if (!admin || !admin.active) {
      throw new UnauthorizedException('Account is no longer active')
    }
    return { id: admin.id, email: admin.email, name: admin.name, role: admin.role }
  }
}
