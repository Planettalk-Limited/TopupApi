import { Body, Controller, Get, Header, Param, Patch, Query, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminCreditbackService } from './admin-creditback.service'
import { ListCreditbackDto } from './dto/list-creditback.dto'
import { UpdateCreditbackStatusDto } from './dto/update-creditback-status.dto'

@Controller('admin/creditback')
@UseGuards(JwtAuthGuard)
export class AdminCreditbackController {
  constructor(private readonly creditback: AdminCreditbackService) {}

  @Get()
  list(@Query() query: ListCreditbackDto) {
    return this.creditback.list(query)
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  export(@Query() query: ListCreditbackDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.creditback.exportCsv(query, admin)
  }

  @Patch(':id/status')
  updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateCreditbackStatusDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.creditback.updateStatus(id, dto, admin)
  }
}
