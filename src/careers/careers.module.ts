import { Module } from '@nestjs/common'
import { CommonModule } from '../common/common.module'
import { CareersController } from './careers.controller'
import { CareersService } from './careers.service'
import { CareersStorageService } from './careers-storage.service'
import { CareersEmailService } from './careers-email.service'
import { CareersRetentionService } from './careers-retention.service'

@Module({
  // CommonModule exports AlertService (needed by CareersRetentionService) — imported
  // explicitly here even though CommonModule is @Global(), matching PaymentsModule's
  // convention rather than relying on implicit global availability.
  imports: [CommonModule],
  controllers: [CareersController],
  providers: [CareersService, CareersStorageService, CareersEmailService, CareersRetentionService],
  exports: [CareersStorageService, CareersEmailService],
})
export class CareersModule {}
