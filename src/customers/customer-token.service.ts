import { Injectable } from '@nestjs/common'
import { JwtService } from '@nestjs/jwt'
import { PrismaService } from '../common/prisma.service'
import {
  AuthenticatedCustomer,
  CUSTOMER_AUDIENCE,
  CustomerJwtPayload,
  toAuthenticatedCustomer,
} from './customer-jwt'

/**
 * Issues and checks customer session tokens. The JwtService injected here is the one
 * CustomersModule registers (its own secret/expiry), not the admin one.
 */
@Injectable()
export class CustomerTokenService {
  constructor(
    private readonly jwt: JwtService,
    private readonly prisma: PrismaService,
  ) {}

  sign(customer: AuthenticatedCustomer): Promise<string> {
    const payload: CustomerJwtPayload = { sub: customer.id, email: customer.email }
    // Audience set explicitly (not only via module signOptions) so a mis-wired module can
    // never mint a customer token the admin guard would accept.
    return this.jwt.signAsync(payload, { audience: CUSTOMER_AUDIENCE })
  }

  /**
   * Resolve an `Authorization: Bearer …` header to a verified customer, or null for a
   * missing, malformed, expired, wrong-audience (e.g. admin) token, or a customer that no
   * longer exists / has not verified their email. Never throws.
   */
  async resolveBearer(authorization: string | undefined | null): Promise<AuthenticatedCustomer | null> {
    if (typeof authorization !== 'string') return null
    const match = /^Bearer\s+(\S+)$/i.exec(authorization.trim())
    if (!match) return null

    let payload: CustomerJwtPayload
    try {
      payload = await this.jwt.verifyAsync<CustomerJwtPayload>(match[1], { audience: CUSTOMER_AUDIENCE })
    } catch {
      return null
    }
    if (!payload?.sub) return null

    const customer = await this.prisma.customer.findUnique({ where: { id: payload.sub } })
    if (!customer || !customer.emailVerifiedAt) return null
    return toAuthenticatedCustomer(customer)
  }
}
