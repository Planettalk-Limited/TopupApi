import { Module } from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'
import { PlanetTalkCatalogController } from './planettalk-catalog.controller'
import { HealthcareService } from './healthcare.service'
import { HealthcareCatalogController } from './healthcare-catalog.controller'
import { VoucherService } from './voucher.service'
import { VoucherCatalogController } from './voucher-catalog.controller'

@Module({
  controllers: [PlanetTalkCatalogController, HealthcareCatalogController, VoucherCatalogController],
  providers: [PlanetTalkService, HealthcareService, VoucherService],
  exports: [PlanetTalkService, HealthcareService, VoucherService],
})
export class BuhibabModule {}
