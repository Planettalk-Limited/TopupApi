import { Controller, Get } from '@nestjs/common'
import { HealthService } from './health.service'

/** Used by the Docker health check and any external uptime monitor. */
@Controller('health')
export class HealthController {
  constructor(private readonly healthService: HealthService) {}

  @Get()
  check() {
    return this.healthService.check()
  }
}
