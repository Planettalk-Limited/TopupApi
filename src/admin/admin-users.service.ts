import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common'
import { AdminRole } from '@prisma/client'
import * as bcrypt from 'bcrypt'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import {
  CreateAdminUserDto,
  ResetAdminPasswordDto,
  UpdateAdminUserDto,
} from './dto/admin-user.dto'

const SALT_ROUNDS = 12

// Never expose the password hash to the client.
const SAFE_SELECT = {
  id: true,
  email: true,
  name: true,
  role: true,
  active: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
} as const

/**
 * SUPERADMIN-only management of admin accounts. Guards against the classic
 * lockout footguns: you can't deactivate/demote/delete yourself, and the last
 * active SUPERADMIN can't be removed. All mutations are audited.
 */
@Injectable()
export class AdminUsersService {
  constructor(private readonly prisma: PrismaService) {}

  list() {
    return this.prisma.adminUser.findMany({
      select: SAFE_SELECT,
      orderBy: { createdAt: 'asc' },
    })
  }

  async create(dto: CreateAdminUserDto, actor: AuthenticatedAdmin) {
    const email = dto.email.toLowerCase()
    const existing = await this.prisma.adminUser.findUnique({ where: { email } })
    if (existing) throw new ConflictException('An admin with that email already exists')

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS)
    const user = await this.prisma.adminUser.create({
      data: {
        email,
        name: dto.name,
        passwordHash,
        role: dto.role ?? AdminRole.ADMIN,
      },
      select: SAFE_SELECT,
    })

    await this.audit(actor, 'admin_user_create', user.id, `${user.email} (${user.role})`)
    return user
  }

  async update(id: string, dto: UpdateAdminUserDto, actor: AuthenticatedAdmin) {
    const target = await this.prisma.adminUser.findUnique({ where: { id } })
    if (!target) throw new NotFoundException('Admin user not found')

    const isSelf = actor.id === id

    // Prevent self-lockout: can't demote or deactivate your own account.
    if (isSelf && dto.active === false) {
      throw new BadRequestException('You cannot deactivate your own account')
    }
    if (isSelf && dto.role && dto.role !== AdminRole.SUPERADMIN) {
      throw new BadRequestException('You cannot remove your own SUPERADMIN role')
    }

    // Protect the last active SUPERADMIN.
    const willLoseSuper =
      target.role === AdminRole.SUPERADMIN &&
      ((dto.role && dto.role !== AdminRole.SUPERADMIN) || dto.active === false)
    if (willLoseSuper) {
      const superAdmins = await this.prisma.adminUser.count({
        where: { role: AdminRole.SUPERADMIN, active: true },
      })
      if (superAdmins <= 1) {
        throw new BadRequestException('At least one active SUPERADMIN must remain')
      }
    }

    const user = await this.prisma.adminUser.update({
      where: { id },
      data: {
        ...(dto.name !== undefined ? { name: dto.name } : {}),
        ...(dto.role !== undefined ? { role: dto.role } : {}),
        ...(dto.active !== undefined ? { active: dto.active } : {}),
      },
      select: SAFE_SELECT,
    })

    await this.audit(actor, 'admin_user_update', id, JSON.stringify(dto))
    return user
  }

  async resetPassword(id: string, dto: ResetAdminPasswordDto, actor: AuthenticatedAdmin) {
    const target = await this.prisma.adminUser.findUnique({ where: { id } })
    if (!target) throw new NotFoundException('Admin user not found')

    const passwordHash = await bcrypt.hash(dto.password, SALT_ROUNDS)
    await this.prisma.adminUser.update({ where: { id }, data: { passwordHash } })
    await this.audit(actor, 'admin_user_reset_password', id, target.email)
    return { ok: true }
  }

  async remove(id: string, actor: AuthenticatedAdmin) {
    const target = await this.prisma.adminUser.findUnique({ where: { id } })
    if (!target) throw new NotFoundException('Admin user not found')

    if (actor.id === id) {
      throw new BadRequestException('You cannot delete your own account')
    }
    if (target.role === AdminRole.SUPERADMIN) {
      const superAdmins = await this.prisma.adminUser.count({
        where: { role: AdminRole.SUPERADMIN, active: true },
      })
      if (superAdmins <= 1) {
        throw new BadRequestException('At least one active SUPERADMIN must remain')
      }
    }

    await this.prisma.adminUser.delete({ where: { id } })
    await this.audit(actor, 'admin_user_delete', id, target.email)
    return { ok: true }
  }

  private audit(actor: AuthenticatedAdmin, action: string, target: string, result: string) {
    return this.prisma.adminAuditLog.create({
      data: { adminId: actor.id, action, target, result },
    })
  }
}
