import { Controller, Get, Req } from '@nestjs/common'
import { Request } from 'express'
import { GeolocationService } from './geolocation.service'

@Controller('geolocation')
export class GeolocationController {
  constructor(private readonly geo: GeolocationService) {}

  @Get()
  async detect(@Req() req: Request) {
    const ip = this.geo.resolveClientIp(
      req.headers['x-forwarded-for'] as string | undefined,
      req.headers['x-real-ip'] as string | undefined,
    )
    // Never throws — always returns a GeoResult (GB default on total failure).
    return this.geo.lookup(ip)
  }
}
