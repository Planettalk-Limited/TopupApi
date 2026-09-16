import { Module } from '@nestjs/common'
import { CareersController } from './careers.controller'
import { CareersService } from './careers.service'
import { CareersStorageService } from './careers-storage.service'
import { CareersEmailService } from './careers-email.service'

@Module({
  controllers: [CareersController],
  providers: [CareersService, CareersStorageService, CareersEmailService],
  exports: [CareersStorageService, CareersEmailService],
})
export class CareersModule {}
