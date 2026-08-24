import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { AlertService } from './alert.service'
import { CustomerEmailService } from './customer-email.service'
import { GaMeasurementProtocolService } from './ga-measurement-protocol.service'
import { RedisService } from './redis.service'

@Global()
@Module({
  providers: [PrismaService, AlertService, CustomerEmailService, RedisService, GaMeasurementProtocolService],
  exports: [PrismaService, AlertService, CustomerEmailService, RedisService, GaMeasurementProtocolService],
})
export class CommonModule {}
