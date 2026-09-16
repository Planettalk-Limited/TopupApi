import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { PaymentsModule } from '../payments/payments.module'
import { CareersModule } from '../careers/careers.module'
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
import { AdminJobPostingsController } from './admin-job-postings.controller'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { AdminJobApplicationsController } from './admin-job-applications.controller'
import { AdminJobApplicationsService } from './admin-job-applications.service'

@Module({
  imports: [AuthModule, PaymentsModule, CareersModule],
  controllers: [
    AdminOrdersController,
    AdminDashboardController,
    AdminCreditbackController,
    AdminSystemController,
    AdminUsersController,
    AdminJobPostingsController,
    AdminJobApplicationsController,
  ],
  providers: [
    AdminOrdersService,
    AdminDashboardService,
    AdminCreditbackService,
    AdminSystemService,
    AdminUsersService,
    AdminJobPostingsService,
    AdminJobApplicationsService,
  ],
})
export class AdminModule {}
