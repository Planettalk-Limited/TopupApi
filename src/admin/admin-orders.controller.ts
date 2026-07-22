import { Controller, Get, Param, Post, Query, UseGuards } from '@nestjs/common'
import { AdminRole } from '@prisma/client'
import { AdminOrdersService } from './admin-orders.service'
import { ListOrdersDto } from './dto/list-orders.dto'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { RolesGuard } from '../auth/roles.guard'
import { Roles } from '../auth/roles.decorator'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

@Controller('admin/orders')
@UseGuards(JwtAuthGuard)
export class AdminOrdersController {
  constructor(private readonly orders: AdminOrdersService) {}

  @Get()
  list(@Query() query: ListOrdersDto) {
    return this.orders.list(query)
  }

  @Get(':paymentIntentId')
  getOne(@Param('paymentIntentId') paymentIntentId: string) {
    return this.orders.getByPaymentIntentId(paymentIntentId)
  }

  @Post(':paymentIntentId/retry')
  retry(
    @Param('paymentIntentId') paymentIntentId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.orders.retry(paymentIntentId, admin)
  }

  // Refunds move money — restricted to SUPERADMIN, mirroring AdminUsersController.
  @Post(':paymentIntentId/refund')
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  refund(
    @Param('paymentIntentId') paymentIntentId: string,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.orders.refund(paymentIntentId, admin)
  }
}
