import { Module } from '@nestjs/common'
import { ReloadlyService } from './reloadly.service'
import { ReloadlyCatalogController } from './reloadly-catalog.controller'

@Module({
  controllers: [ReloadlyCatalogController],
  providers: [ReloadlyService],
  exports: [ReloadlyService],
})
export class ReloadlyModule {}
