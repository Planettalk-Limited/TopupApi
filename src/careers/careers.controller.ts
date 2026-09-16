import { Controller, Get, Param } from '@nestjs/common'
import { CareersService } from './careers.service'

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
}
