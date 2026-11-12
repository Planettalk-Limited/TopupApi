import { Module } from '@nestjs/common'
import { AuthModule } from '../auth/auth.module'
import { MonitoringController } from './monitoring.controller'
import { SyntheticMonitorService } from './synthetic-monitor.service'

// AlertService comes from the global CommonModule and SchedulerRegistry from
// ScheduleModule.forRoot() in AppModule. AuthModule is imported for the admin JWT guard,
// the same way AdminModule does.
@Module({
  imports: [AuthModule],
  controllers: [MonitoringController],
  providers: [SyntheticMonitorService],
})
export class MonitoringModule {}
