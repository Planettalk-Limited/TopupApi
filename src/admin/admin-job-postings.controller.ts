import { Body, Controller, Delete, Get, Param, Patch, Post, UseGuards } from '@nestjs/common'
import { JwtAuthGuard } from '../auth/jwt-auth.guard'
import { CurrentAdmin } from '../auth/current-admin.decorator'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { CreateJobPostingDto, UpdateJobPostingDto } from './dto/job-posting.dto'

@Controller('admin/job-postings')
@UseGuards(JwtAuthGuard)
export class AdminJobPostingsController {
  constructor(private readonly postings: AdminJobPostingsService) {}

  @Get()
  list() {
    return this.postings.list()
  }

  @Post()
  create(@Body() dto: CreateJobPostingDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.create(dto, admin)
  }

  @Patch(':id')
  update(@Param('id') id: string, @Body() dto: UpdateJobPostingDto, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.update(id, dto, admin)
  }

  @Delete(':id')
  remove(@Param('id') id: string, @CurrentAdmin() admin: AuthenticatedAdmin) {
    return this.postings.remove(id, admin)
  }
}
