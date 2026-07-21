import { Module } from '@nestjs/common'
import { CreditbackController } from './creditback.controller'
import { CreditbackService } from './creditback.service'

@Module({
  controllers: [CreditbackController],
  providers: [CreditbackService],
})
export class CreditbackModule {}
