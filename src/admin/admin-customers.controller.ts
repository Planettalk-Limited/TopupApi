import { Controller, Get, Header, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminCustomersService } from './admin-customers.service'
import { ListCustomersDto } from './dto/list-customers.dto'

/** Read-only view of customer accounts. Password hashes are never selected. */
@Controller('admin/customers')
@UseGuards(JwtAuthGuard)
export class AdminCustomersController {
  constructor(private readonly customers: AdminCustomersService) {}

  @Get()
  list(@Query() query: ListCustomersDto) {
    return this.customers.list(query)
  }

  // Declared before ':id' so "export" is not parsed as an id.
  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  export(@Query() query: ListCustomersDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.customers.exportCsv(query, admin)
  }

  @Get(':id')
  getOne(@Param('id', ParseUUIDPipe) id: string) {
    return this.customers.getById(id)
  }
}
