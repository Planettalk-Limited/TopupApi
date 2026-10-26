import { Controller, Get, Req } from '@nestjs/common'
import { Request } from 'express'
import { GeolocationService, UK_DEFAULT } from './geolocation.service'

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
    // No public IP (local dev) gets the default too, never a guessed country.
    return ip ? this.geo.lookup(ip) : UK_DEFAULT('unknown')
  }
}
