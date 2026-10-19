import { Module } from '@nestjs/common'
import { BuhibabModule } from '../buhibab/buhibab.module'
import { CatalogCountriesService } from './catalog-countries.service'
import { ReloadlyService } from './reloadly.service'
import { ReloadlyCatalogController } from './reloadly-catalog.controller'

@Module({
  // BuhibabModule: NG utility countries follow TOPUP_PROVIDER_NG and may be PlanetTalk billers.
  imports: [BuhibabModule],
  controllers: [ReloadlyCatalogController],
  providers: [ReloadlyService, CatalogCountriesService],
  exports: [ReloadlyService],
})
export class ReloadlyModule {}
