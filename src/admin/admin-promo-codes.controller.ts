import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminPromoCodesService } from './admin-promo-codes.service'
import { CreatePromoCodeBatchDto, CreatePromoCodeDto, UpdatePromoCodeDto } from './dto/promo-code.dto'

/** Promo code management. No DELETE: deactivate instead (redemptions keep their history). */
@Controller('admin/promo-codes')
@UseGuards(JwtAuthGuard)
export class AdminPromoCodesController {
  constructor(private readonly promoCodes: AdminPromoCodesService) {}

  @Get()
  list() {
    return this.promoCodes.list()
  }

  @Get('export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  export(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.promoCodes.exportCsv(admin)
  }

  @Post()
  create(@Body() dto: CreatePromoCodeDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.promoCodes.create(dto, admin)
  }

  /** Single-use codes in bulk, for handing out to a selected group. */
  @Post('batch')
  createBatch(@Body() dto: CreatePromoCodeBatchDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.promoCodes.createBatch(dto, admin)
  }

  @Patch(':id')
  update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePromoCodeDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.promoCodes.update(id, dto, admin)
  }
}
