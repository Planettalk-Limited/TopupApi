import { Body, Controller, HttpCode, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { CustomerAuthService } from './customer-auth.service'
import {
  CheckCustomerDto,
  CustomerLoginDto,
  EmailOnlyDto,
  ForgotPasswordDto,
  RegisterCustomerDto,
  ResetPasswordDto,
  VerifyEmailDto,
} from './dto/customer-auth.dto'

/**
 * Buyer sign-up / log-in (webmart review D.2). Every route is public, so each carries a
 * tight per-IP limit on top of the global 60/min — these are the brute-force and
 * email-flooding surfaces.
 */
@Controller('customer-auth')
export class CustomerAuthController {
  constructor(private readonly auth: CustomerAuthService) {}

  @Throttle({ default: { limit: 20, ttl: 600_000 } })
  @HttpCode(200)
  @Post('check')
  check(@Body() dto: CheckCustomerDto) {
    return this.auth.check(dto)
  }

  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('register')
  register(@Body() dto: RegisterCustomerDto) {
    return this.auth.register(dto)
  }

  // 5 wrong guesses lock a code server-side; this caps how many codes one IP can try.
  @Throttle({ default: { limit: 10, ttl: 600_000 } })
  @HttpCode(200)
  @Post('verify-email')
  verifyEmail(@Body() dto: VerifyEmailDto) {
    return this.auth.verifyEmail(dto.email, dto.code)
  }

  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @HttpCode(200)
  @Post('resend-verification')
  resendVerification(@Body() dto: EmailOnlyDto) {
    return this.auth.resendVerification(dto.email)
  }

  // Same budget as the admin login.
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @HttpCode(200)
  @Post('login')
  login(@Body() dto: CustomerLoginDto) {
    return this.auth.login(dto.email, dto.password)
  }

  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() dto: ForgotPasswordDto) {
    return this.auth.forgotPassword(dto.email, dto.locale)
  }

  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body() dto: ResetPasswordDto) {
    return this.auth.resetPassword(dto.token, dto.password)
  }
}
