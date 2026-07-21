import { SetMetadata } from '@nestjs/common'
import { AdminRole } from '@prisma/client'

export const ROLES_KEY = 'roles'

/**
 * Restrict a route to one or more admin roles. Used with RolesGuard, which
 * must run after JwtAuthGuard (so request.user is populated). No decorator =
 * any authenticated admin.
 */
export const Roles = (...roles: AdminRole[]) => SetMetadata(ROLES_KEY, roles)
