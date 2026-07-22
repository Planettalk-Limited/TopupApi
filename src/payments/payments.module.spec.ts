import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { FulfillmentService } from './fulfillment.service'
import { PaymentsController } from './payments.controller'
import { PaymentsModule } from './payments.module'

describe('PaymentsModule', () => {
  it('compiles and resolves PaymentsController + FulfillmentService without a real DB/Redis', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), PaymentsModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    expect(moduleRef.get(PaymentsController)).toBeDefined()
    expect(moduleRef.get(FulfillmentService)).toBeDefined()
  })
})
