import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { timingSafeEqual } from 'crypto'
import { Request } from 'express'

/**
 * Static shared-secret guard for machine-to-machine endpoints (e.g. the
 * balance-alert cron poll). NOT for human admins — those use JwtAuthGuard.
 * Mirrors TopupApp's `isAuthorizedAdmin`: fail-closed if ADMIN_API_TOKEN unset,
 * constant-time comparison of the `Authorization: Bearer <token>` header.
 */
@Injectable()
export class AdminTokenGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const token = this.config.get<string>('ADMIN_API_TOKEN')
    if (!token) return false // fail closed

    const req = context.switchToHttp().getRequest<Request>()
    const header = req.headers['authorization']
    if (!header) return false

    const expected = `Bearer ${token}`
    return this.safeEqual(header, expected)
  }

  private safeEqual(a: string, b: string): boolean {
    const ab = Buffer.from(a)
    const bb = Buffer.from(b)
    if (ab.length !== bb.length) return false
    return timingSafeEqual(ab, bb)
  }
}
