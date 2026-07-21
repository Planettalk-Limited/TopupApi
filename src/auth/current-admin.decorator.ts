import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { Request } from 'express'
import { AuthenticatedAdmin } from './jwt-payload.interface'

/** Injects the authenticated admin (set by JwtStrategy.validate) into a handler. */
export const CurrentAdmin = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedAdmin => {
    const req = ctx.switchToHttp().getRequest<Request & { user: AuthenticatedAdmin }>()
    return req.user
  },
)
