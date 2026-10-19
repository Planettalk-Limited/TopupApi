import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
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

  @Get('provider-logs/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  exportProviderLogs(@Query() query: ListProviderLogsDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.system.exportProviderLogs(query, admin)
  }

  @Get('audit-log')
  auditLog(@Query() query: ListAuditLogDto) {
    return this.system.auditLog(query)
  }

  @Get('audit-log/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  exportAuditLog(@Query() query: ListAuditLogDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.system.exportAuditLog(query, admin)
  }
}
