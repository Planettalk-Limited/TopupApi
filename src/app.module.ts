import { Module } from '@nestjs/common'
import { ConfigModule } from '@nestjs/config'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { CommonModule } from './common/common.module'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { HealthModule } from './health/health.module'
import { CreditbackModule } from './creditback/creditback.module'
import { AuthModule } from './auth/auth.module'
import { AdminModule } from './admin/admin.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Baseline global rate limit (per-route overrides, e.g. on the
    // creditback claim endpoint, are tighter — see creditback.controller.ts).
    ThrottlerModule.forRoot([{ ttl: 60_000, limit: 60 }]),
    CommonModule,
    HealthModule,
    CreditbackModule,
    AuthModule,
    AdminModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
