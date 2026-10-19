/**
 * Customer (buyer) JWTs carry `aud: 'customer'`. Admin JWTs carry no audience, so:
 *   - the customer guard verifies with `audience: 'customer'` and rejects admin tokens;
 *   - the admin JwtStrategy rejects any token that has an audience at all.
 * Keep the two token kinds strictly apart — a buyer must never reach /api/admin.
 */
export const CUSTOMER_AUDIENCE = 'customer'

export interface CustomerJwtPayload {
  sub: string // Customer.id
  email: string
  aud?: string | string[]
}

/** Public customer shape — the `customer` object in every auth response, and request.customer. */
export interface AuthenticatedCustomer {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
}

export function toAuthenticatedCustomer(row: {
  id: string
  email: string
  firstName: string
  lastName: string
  phone: string
}): AuthenticatedCustomer {
  return { id: row.id, email: row.email, firstName: row.firstName, lastName: row.lastName, phone: row.phone }
}
