import { createParamDecorator, ExecutionContext } from '@nestjs/common'
import { AuthenticatedCustomer } from './customer-jwt'
import type { CustomerRequest } from './customer-auth.guard'

/** Injects the customer attached by CustomerAuthGuard. */
export const CurrentCustomer = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedCustomer => {
    return ctx.switchToHttp().getRequest<CustomerRequest>().customer as AuthenticatedCustomer
  },
)
