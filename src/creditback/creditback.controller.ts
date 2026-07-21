import { Body, Controller, Post } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { CreditbackService } from './creditback.service'
import { CreateClaimDto } from './dto/create-claim.dto'

@Controller('creditback')
export class CreditbackController {
  constructor(private readonly creditbackService: CreditbackService) {}

  // Public, unauthenticated lead-capture endpoint — tighter than the global
  // default since a single visitor should only ever submit this once or
  // twice per completed transaction.
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Post('claim')
  async claim(@Body() dto: CreateClaimDto) {
    const claim = await this.creditbackService.createClaim(dto)
    return { success: true, id: claim.id }
  }
}
