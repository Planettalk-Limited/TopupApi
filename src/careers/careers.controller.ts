import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common'
import { FileInterceptor } from '@nestjs/platform-express'
import { Throttle } from '@nestjs/throttler'
import { CareersService } from './careers.service'
import { SubmitApplicationDto } from './dto/submit-application.dto'

@Controller('careers')
export class CareersController {
  constructor(private readonly careers: CareersService) {}

  @Get('jobs')
  listJobs() {
    return this.careers.listOpenJobs()
  }

  @Get('jobs/:id')
  getJob(@Param('id') id: string) {
    return this.careers.getJobById(id)
  }

  // Public, unauthenticated application endpoint — tighter than the global
  // default since a single visitor should only ever submit this a handful of
  // times, matching the creditback-claim precedent.
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('jobs/:id/apply')
  @UseInterceptors(FileInterceptor('cv', { limits: { fileSize: 5 * 1024 * 1024 } }))
  async apply(
    @Param('id') id: string,
    @Body() dto: SubmitApplicationDto,
    @UploadedFile() cv?: Express.Multer.File,
  ) {
    if (!cv) throw new BadRequestException('A CV file is required')
    return this.careers.submitApplication(id, dto, cv)
  }
}
