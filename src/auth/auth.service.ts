import { Injectable, UnauthorizedException } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import * as bcrypt from 'bcrypt'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin, JwtPayload } from './jwt-payload.interface'

@Injectable()
export class AuthService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly jwt: JwtService,
  ) {}

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
