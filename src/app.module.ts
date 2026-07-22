import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { APP_FILTER, APP_GUARD } from '@nestjs/core'
import { ThrottlerGuard, ThrottlerModule } from '@nestjs/throttler'
import { ThrottlerStorageRedisService } from '@nest-lab/throttler-storage-redis'
import { CommonModule } from './common/common.module'
import { AllExceptionsFilter } from './common/all-exceptions.filter'
import { HealthModule } from './health/health.module'
import { CreditbackModule } from './creditback/creditback.module'
import { AuthModule } from './auth/auth.module'
import { AdminModule } from './admin/admin.module'
import { ReloadlyModule } from './providers/reloadly/reloadly.module'
import { BuhibabModule } from './providers/buhibab/buhibab.module'
import { CurrencyModule } from './currency/currency.module'
import { GeolocationModule } from './geolocation/geolocation.module'
import { PaymentsModule } from './payments/payments.module'

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    // Baseline global rate limit (per-route overrides, e.g. on the creditback
    // claim + admin login endpoints, are tighter). Backed by Redis when
    // REDIS_URL is set so limits are shared across replicas; falls back to
    // in-memory otherwise (local dev / single instance).
    ThrottlerModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        const redisUrl = config.get<string>('REDIS_URL')
        return {
          throttlers: [{ ttl: 60_000, limit: 60 }],
          ...(redisUrl ? { storage: new ThrottlerStorageRedisService(redisUrl) } : {}),
        }
      },
    }),
    CommonModule,
    HealthModule,
    CreditbackModule,
    AuthModule,
    AdminModule,
    ReloadlyModule,
    BuhibabModule,
    CurrencyModule,
    GeolocationModule,
    PaymentsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_FILTER, useClass: AllExceptionsFilter },
  ],
})
export class AppModule {}
