import { Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards, Body } from '@nestjs/common'
import type { Response } from 'express'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminJobApplicationsService } from './admin-job-applications.service'
import { SetApplicationStatusDto } from './dto/job-application.dto'

@Controller('admin/job-applications')
@UseGuards(JwtAuthGuard)
export class AdminJobApplicationsController {
  constructor(private readonly applications: AdminJobApplicationsService) {}

  @Get()
  list(@Query('jobPostingId') jobPostingId?: string, @Query('status') status?: any) {
    return this.applications.list({ jobPostingId, status })
  }

  @Patch(':id/status')
  setStatus(@Param('id') id: string, @Body() dto: SetApplicationStatusDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.setStatus(id, dto.status, admin)
  }

  @Post(':id/reject')
  reject(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.reject(id, admin)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.applications.remove(id, admin)
  }

  @Get(':id/cv')
  async downloadCv(@Param('id') id: string, @Res() res: Response) {
    const { body, contentType, filename } = await this.applications.getCv(id)
    res.setHeader('Content-Type', contentType)
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`)
    ;(body as any).pipe(res)
  }
}
