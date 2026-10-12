import { Module } from '@nestjs/common'
import { ConfigModule, ConfigService } from '@nestjs/config'
import { JwtModule } from '@nestjs/jwt'
import { BeneficiariesService } from './beneficiaries.service'
import { CustomerAuthController } from './customer-auth.controller'
import { CustomerAuthGuard } from './customer-auth.guard'
import { CustomerAuthService } from './customer-auth.service'
import { CUSTOMER_AUDIENCE } from './customer-jwt'
import { CustomerTokenService } from './customer-token.service'
import { CustomerController } from './customer.controller'

/**
 * Buyer accounts. Deliberately separate from AuthModule (admins): its own JwtModule
 * instance — own secret when CUSTOMER_JWT_SECRET is set, own expiry, and the 'customer'
 * audience on sign and verify.
 */
@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret:
          config.get<string>('CUSTOMER_JWT_SECRET') || config.get<string>('JWT_SECRET') || 'change-me-in-env',
        signOptions: {
          audience: CUSTOMER_AUDIENCE,
          expiresIn: config.get<string>('CUSTOMER_JWT_EXPIRES_IN') ?? '30d',
        },
        verifyOptions: { audience: CUSTOMER_AUDIENCE },
      }),
    }),
  ],
  controllers: [CustomerAuthController, CustomerController],
  providers: [CustomerAuthService, CustomerTokenService, CustomerAuthGuard, BeneficiariesService],
  // CustomerTokenService: PaymentsModule reads the optional Bearer on create-intent.
  // CustomerAuthGuard: promo validation is customer-only.
  exports: [CustomerTokenService, CustomerAuthGuard],
})
export class CustomersModule {}
