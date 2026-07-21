import { Global, Module } from '@nestjs/common'
import { PrismaService } from './prisma.service'
import { AlertService } from './alert.service'

@Global()
@Module({
  providers: [PrismaService, AlertService],
  exports: [PrismaService, AlertService],
})
export class CommonModule {}
