import { AdminRole } from '@prisma/client'

export interface JwtPayload {
  sub: string // AdminUser.id
  email: string
  role: AdminRole
}

// Shape attached to request.user after JwtStrategy.validate()
export interface AuthenticatedAdmin {
  id: string
  email: string
  name: string
  role: AdminRole
}
