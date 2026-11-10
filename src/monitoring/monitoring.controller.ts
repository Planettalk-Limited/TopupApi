import { Controller, Get, Header, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { SyntheticMonitorService } from './synthetic-monitor.service'

/**
 * Current state of every synthetic check, for the admin console / anyone on call who
 * gets an alert email and wants to see what else is red. Admin-JWT only: the targets
 * reveal internal URLs and the errors can echo provider responses.
 */
@Controller('admin/monitoring')
@UseGuards(JwtAuthGuard)
export class MonitoringController {
  constructor(private readonly monitor: SyntheticMonitorService) {}

  @Get('status')
  @Header('Cache-Control', 'no-store')
  status() {
    return this.monitor.status()
  }
}
