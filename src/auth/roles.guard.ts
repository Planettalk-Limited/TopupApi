import { CanActivate, ExecutionContext, ForbiddenException, Injectable } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { AdminRole } from '@prisma/client'
import { ROLES_KEY } from './roles.decorator'
import { AuthenticatedAdmin } from './jwt-payload.interface'

/**
 * Enforces @Roles(...) on a handler. Assumes JwtAuthGuard has already run and
 * attached request.user. When no @Roles decorator is present, allows any
 * authenticated admin through.
 */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<AdminRole[] | undefined>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ])
    if (!required || required.length === 0) return true

    const { user } = ctx.switchToHttp().getRequest<{ user?: AuthenticatedAdmin }>()
    if (!user || !required.includes(user.role)) {
      throw new ForbiddenException('This action requires elevated permissions')
    }
    return true
  }
}
