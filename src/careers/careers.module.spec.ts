import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { CareersController } from './careers.controller'
import { CareersService } from './careers.service'
import { CareersStorageService } from './careers-storage.service'
import { CareersEmailService } from './careers-email.service'
import { CareersRetentionService } from './careers-retention.service'
import { CareersModule } from './careers.module'

describe('CareersModule', () => {
  it('compiles and resolves its controller + services without a real DB/Redis', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), CareersModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    expect(moduleRef.get(CareersController)).toBeDefined()
    expect(moduleRef.get(CareersService)).toBeDefined()
    expect(moduleRef.get(CareersStorageService)).toBeDefined()
    expect(moduleRef.get(CareersEmailService)).toBeDefined()
    expect(moduleRef.get(CareersRetentionService)).toBeDefined()
  })
})
