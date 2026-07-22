import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PaymentsModule } from '../payments/payments.module'
import { AdminOrdersController } from './admin-orders.controller'
import { AdminOrdersService } from './admin-orders.service'
import { AdminDashboardController } from './admin-dashboard.controller'
import { AdminDashboardService } from './admin-dashboard.service'
import { AdminCreditbackController } from './admin-creditback.controller'
import { AdminCreditbackService } from './admin-creditback.service'
import { AdminSystemController } from './admin-system.controller'
import { AdminSystemService } from './admin-system.service'
import { AdminUsersController } from './admin-users.controller'
import { AdminUsersService } from './admin-users.service'

@Module({
  imports: [AuthModule, PaymentsModule],
  controllers: [
    AdminOrdersController,
    AdminDashboardController,
    AdminCreditbackController,
    AdminSystemController,
    AdminUsersController,
  ],
  providers: [
    AdminOrdersService,
    AdminDashboardService,
    AdminCreditbackService,
    AdminSystemService,
    AdminUsersService,
  ],
})
export class AdminModule {}
