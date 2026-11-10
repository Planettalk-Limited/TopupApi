import { Body, Controller, Get, Header, HttpCode, Param, Post, UseGuards } from '@nestjs/common'
import { Throttle } from '@nestjs/throttler'
import { CustomerAuthGuard } from '../customers/customer-auth.guard'
import { CurrentCustomer } from '../customers/current-customer.decorator'
import type { AuthenticatedCustomer } from '../customers/customer-jwt'
import { GiftCampaignService } from './gift-campaign.service'
import { SubmitGiftDto } from './dto/gift-campaign.dto'

/**
 * Public landing-page endpoints. The opaque link token is the only credential; responses
 * carry no order or customer ids. Throttled tightly: tokens are 256-bit, but there is no
 * reason to let anyone probe them quickly.
 */
@Controller('gift-campaign/links')
export class GiftCampaignController {
  constructor(private readonly gifts: GiftCampaignService) {}

  @Get(':token')
  @Throttle({ default: { limit: 30, ttl: 600_000 } })
  @Header('Cache-Control', 'no-store')
  @Header('Referrer-Policy', 'no-referrer')
  view(@Param('token') token: string) {
    return this.gifts.viewLink(token)
  }

  @Post(':token/submission')
  @HttpCode(201)
  @Throttle({ default: { limit: 5, ttl: 600_000 } })
  @Header('Cache-Control', 'no-store')
  submit(@Param('token') token: string, @Body() dto: SubmitGiftDto) {
    return this.gifts.submit(token, dto)
  }
}

/** The signed-in customer's own campaign links (for showing in-app). */
@Controller('customer/gift-campaign')
@UseGuards(CustomerAuthGuard)
export class CustomerGiftCampaignController {
  constructor(private readonly gifts: GiftCampaignService) {}

  @Get()
  @Header('Cache-Control', 'no-store')
  mine(@CurrentCustomer() customer: AuthenticatedCustomer) {
    return this.gifts.listForCustomer(customer.id)
  }
}
