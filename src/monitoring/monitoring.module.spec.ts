import { ConfigModule } from '@nestjs/config'
import { ScheduleModule } from '@nestjs/schedule'
import { Test } from '@nestjs/testing'
import { CommonModule } from '../common/common.module'
import { PrismaService } from '../common/prisma.service'
import { RedisService } from '../common/redis.service'
import { MonitoringController } from './monitoring.controller'
import { MonitoringModule } from './monitoring.module'
import { SyntheticMonitorService } from './synthetic-monitor.service'

// DI-wiring smoke test (same motivation as admin.module.spec.ts): the unit specs build the
// service by hand, so only this catches a dependency the module can't actually resolve
// (AlertService from the global CommonModule, SchedulerRegistry from ScheduleModule, the
// JWT guard from AuthModule).
describe('MonitoringModule', () => {
  it('compiles and wires the status endpoint to the monitor', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true }), ScheduleModule.forRoot(), CommonModule, MonitoringModule],
    })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({})
      .compile()

    const monitor = moduleRef.get(SyntheticMonitorService)
    expect(monitor.checks.length).toBeGreaterThan(0)
    expect(moduleRef.get(MonitoringController).status()).toMatchObject({
      summary: { total: monitor.checks.length },
    })
  })
})
