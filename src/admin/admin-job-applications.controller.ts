import { Controller, Delete, Get, Param, Patch, Post, Query, Res, UseGuards, Body } from '@nestjs/common'
import type { Response } from 'express'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminJobApplicationsService } from './admin-job-applications.service'
import { SetApplicationStatusDto } from './dto/job-application.dto'

// ASCII-only fallback for the filename= token (quotes/backslashes stripped,
// non-ASCII replaced) — browsers that don't support filename* still get a safe
// name, and Node's header validation (which rejects code points above \xff)
// never sees anything it would reject.
export function sanitizeFilename(filename: string): string {
  return filename.replace(/["\\]/g, '').replace(/[^\x20-\x7e]/g, '_') || 'cv'
}

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
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${sanitizeFilename(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    )
    const stream = body as NodeJS.ReadableStream
    stream.on('error', (err) => {
      // headers may already be sent by this point; res.destroy() ends the connection
      // rather than attempting a second response, which would throw ERR_HTTP_HEADERS_SENT
      res.destroy(err instanceof Error ? err : new Error(String(err)))
    })
    stream.pipe(res)
  }
}
