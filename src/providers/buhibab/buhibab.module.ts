import { Module } from '@nestjs/common'
import { PlanetTalkService } from './planettalk.service'
import { PlanetTalkCatalogController } from './planettalk-catalog.controller'

@Module({
  controllers: [PlanetTalkCatalogController],
  providers: [PlanetTalkService],
  exports: [PlanetTalkService],
})
export class BuhibabModule {}
