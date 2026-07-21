import { Controller, Get, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { AdminSystemService } from './admin-system.service'
import { ListAuditLogDto, ListProviderLogsDto } from './dto/list-logs.dto'

@Controller('admin')
@UseGuards(JwtAuthGuard)
export class AdminSystemController {
  constructor(private readonly system: AdminSystemService) {}

  @Get('providers/health')
  providerHealth() {
    return this.system.providerHealth()
  }

  @Get('provider-logs')
  providerLogs(@Query() query: ListProviderLogsDto) {
    return this.system.providerLogs(query)
  }

  @Get('audit-log')
  auditLog(@Query() query: ListAuditLogDto) {
    return this.system.auditLog(query)
  }
}
