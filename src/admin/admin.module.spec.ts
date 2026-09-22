import { ConfigModule } from '@nestjs/config'
import { Test } from '@nestjs/testing'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { AdminModule } from './admin.module'
import { AdminJobPostingsService } from './admin-job-postings.service'
import { AdminJobApplicationsService } from './admin-job-applications.service'

// AdminModule pulls in AuthModule + PaymentsModule + CareersModule — a full DI-wiring
// smoke test (same motivation as payments.module.spec.ts: hand-mocked unit tests can't
// catch a service depending on a provider its module never registers, a missing export,
// or a circular import). Scoped to asserting the module compiles and that the two
// careers admin services resolve cleanly now that CareersModule is one of its imports.
describe('AdminModule', () => {
  it('compiles and resolves AdminJobPostingsService + AdminJobApplicationsService without a real DB/Redis', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), AdminModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    expect(moduleRef.get(AdminJobPostingsService)).toBeDefined()
    expect(moduleRef.get(AdminJobApplicationsService)).toBeDefined()
  })
})
