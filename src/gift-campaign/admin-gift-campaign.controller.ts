import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common'
import { AdminRole } from '@prisma/client'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { RolesGuard } from '../auth/roles.guard'
import { Roles } from '../auth/roles.decorator'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import type { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { GiftCampaignAdminService } from './gift-campaign-admin.service'
import { GiftVoucherIssuerService } from './gift-voucher-issuer.service'
import {
  AssignGiftDto,
  ContactAttemptDto,
  GiftNoteDto,
  IssueGiftVoucherDto,
  ListGiftEntitlementsDto,
  ListGiftSubmissionsDto,
  TransitionGiftDto,
} from './dto/gift-campaign.dto'

@Controller('admin/gift-campaign')
@UseGuards(JwtAuthGuard)
export class AdminGiftCampaignController {
  constructor(
    private readonly admin: GiftCampaignAdminService,
    private readonly issuer: GiftVoucherIssuerService,
  ) {}

  @Get()
  overview() {
    return this.admin.overview()
  }

  @Get('submissions')
  list(@Query() query: ListGiftSubmissionsDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admin.list(query, admin)
  }

  // Declared before ':id' so "export" is not parsed as an id.
  @Get('submissions/export')
  @Header('Content-Type', 'text/csv; charset=utf-8')
  @Header('Cache-Control', 'no-store')
  export(@Query() query: ListGiftSubmissionsDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admin.exportCsv(query, admin)
  }

  @Get('submissions/:id')
  get(@Param('id', ParseUUIDPipe) id: string) {
    return this.admin.get(id)
  }

  @Post('submissions/:id/status')
  transition(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: TransitionGiftDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.admin.transition(id, dto, admin)
  }

  @Post('submissions/:id/contact-attempts')
  contact(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ContactAttemptDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.admin.contactAttempt(id, dto, admin)
  }

  @Post('submissions/:id/notes')
  note(@Param('id', ParseUUIDPipe) id: string, @Body() dto: GiftNoteDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admin.addNote(id, dto, admin)
  }

  @Post('submissions/:id/assign')
  assign(@Param('id', ParseUUIDPipe) id: string, @Body() dto: AssignGiftDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admin.assign(id, dto, admin)
  }

  // Spends real buhibab balance — restricted to SUPERADMIN, like refunds.
  @Post('submissions/:id/issue-voucher')
  @UseGuards(RolesGuard)
  @Roles(AdminRole.SUPERADMIN)
  issueVoucher(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: IssueGiftVoucherDto,
    @CurrentAdmin() admin: AuthenticatedAdmin,
  ) {
    return this.issuer.issue(id, admin, dto)
  }

  @Get('links')
  links(@Query() query: ListGiftEntitlementsDto) {
    return this.admin.listEntitlements(query)
  }

  @Post('links/:id/resend')
  resend(@Param('id', ParseUUIDPipe) id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.admin.resendLink(id, admin)
  }
}
