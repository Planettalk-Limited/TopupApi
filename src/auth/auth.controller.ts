import { Body, Controller, Get, HttpCode, Post, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { AuthService } from './auth.service'
import { LoginDto } from './dto/login.dto'
import { AdminForgotPasswordDto, AdminResetPasswordDto } from './dto/password-reset.dto'
import { JwtAuthGuard } from './jwt-auth.guard'
import { CurrentAdmin } from './current-admin.decorator'
import { AuthenticatedAdmin } from './jwt-payload.interface'

@Controller('admin/auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  // Tight limit — brute-force protection on the login endpoint.
  @Throttle({ default: { limit: 10, ttl: 300_000 } })
  @Post('login')
  login(@Body() dto: LoginDto) {
    return this.authService.login(dto.email, dto.password)
  }

  @Throttle({ default: { limit: 3, ttl: 600_000 } })
  @HttpCode(200)
  @Post('forgot-password')
  forgotPassword(@Body() dto: AdminForgotPasswordDto) {
    return this.authService.forgotPassword(dto.email)
  }

  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @HttpCode(200)
  @Post('reset-password')
  resetPassword(@Body() dto: AdminResetPasswordDto) {
    return this.authService.resetPassword(dto.token, dto.password)
  }

  // Lets the admin UI validate a stored token and hydrate the current user.
  @UseGuards(JwtAuthGuard)
  @Get('me')
  me(@CurrentAdmin() admin: AuthenticatedAdmin) {
    return admin
  }
}
