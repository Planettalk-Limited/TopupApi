import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { AlertService } from './alert.service'
import { RedisService } from './redis.service'

@Global()
@Module({
  providers: [PrismaService, AlertService, RedisService],
  exports: [PrismaService, AlertService, RedisService],
})
export class CommonModule {}
