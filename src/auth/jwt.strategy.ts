import { Injectable, UnauthorizedException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { PassportStrategy } from '@nestjs/passport'
import { ExtractJwt, Strategy } from 'passport-jwt'
import { AuthService } from './auth.service'
import { AuthenticatedAdmin, JwtPayload } from './jwt-payload.interface'

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private readonly authService: AuthService,
    config: ConfigService,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: config.get<string>('JWT_SECRET') ?? 'change-me-in-env',
    })
  }

  async validate(payload: JwtPayload & { aud?: unknown }): Promise<AuthenticatedAdmin> {
    // Admin tokens never carry an audience; customer tokens always do (aud: 'customer',
    // see src/customers/customer-jwt.ts). Refuse any audience-bearing token outright so a
    // buyer session can never reach /api/admin, even if both share JWT_SECRET.
    if (payload.aud !== undefined) {
      throw new UnauthorizedException('Invalid token')
    }
    return this.authService.validateJwtPayload(payload)
  }
}
