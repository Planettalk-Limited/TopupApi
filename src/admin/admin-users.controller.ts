import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common'
import { AdminRole } from '@prisma/client'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { RolesGuard } from '../auth/roles.guard'
import { Roles } from '../auth/roles.decorator'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminUsersService } from './admin-users.service'
import {
  CreateAdminUserDto,
  ResetAdminPasswordDto,
  UpdateAdminUserDto,
} from './dto/admin-user.dto'

@Controller('admin/users')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(AdminRole.SUPERADMIN)
export class AdminUsersController {
  constructor(private readonly users: AdminUsersService) {}

  @Get()
  list() {
    return this.users.list()
  }

  @Post()
  create(@Body() dto: CreateAdminUserDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.users.create(dto, admin)
  }

  @Patch(':id')
  update(
    @Param('id') id: string,
    @Body() dto: UpdateAdminUserDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.users.update(id, dto, admin)
  }

  @Patch(':id/password')
  resetPassword(
    @Param('id') id: string,
    @Body() dto: ResetAdminPasswordDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.users.resetPassword(id, dto, admin)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.users.remove(id, admin)
  }
}
