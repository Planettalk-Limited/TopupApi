import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from '@nestjs/common'
import { Request } from 'express'
import { AuthenticatedCustomer } from './customer-jwt'
import { CustomerTokenService } from './customer-token.service'

export type CustomerRequest = Request & { customer?: AuthenticatedCustomer }

/**
 * Guards buyer routes: requires a valid Bearer token with `aud: 'customer'` for a
 * verified, existing customer. Admin tokens (no audience) are rejected here, exactly as
 * the admin JwtStrategy rejects customer tokens.
 */
@Injectable()
export class CustomerAuthGuard implements CanActivate {
  constructor(private readonly tokens: CustomerTokenService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CustomerRequest>()
    const customer = await this.tokens.resolveBearer(req.headers['authorization'])
    if (!customer) {
      throw new UnauthorizedException('Please log in to continue')
    }
    req.customer = customer
    return true
  }
}
