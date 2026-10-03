import { Module } from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'
import { PlanetTalkCatalogController } from './planettalk-catalog.controller'
import { HealthcareService } from './healthcare.service'
import { HealthcareCatalogController } from './healthcare-catalog.controller'

@Module({
  controllers: [PlanetTalkCatalogController, HealthcareCatalogController],
  providers: [PlanetTalkService, HealthcareService],
  exports: [PlanetTalkService, HealthcareService],
})
export class BuhibabModule {}
