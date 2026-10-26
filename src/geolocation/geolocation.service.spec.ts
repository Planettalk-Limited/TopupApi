import { GeolocationService, isPrivateIp } from './geolocation.service'
import { RedisService } from '../common/redis.service'

describe('isPrivateIp', () => {
  it.each(['10.1.2.3', '127.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.1.1', '100.64.0.1', '169.254.1.1', '::1', '::ffff:10.0.0.1', 'fd00::1', 'fe80::1', 'unknown'])(
    'treats %s as private',
    (ip) => expect(isPrivateIp(ip)).toBe(true),
  )

  it.each(['172.58.1.1', '172.32.0.1', '172.15.0.1', '8.8.8.8', '41.57.0.1', '2607:fb90::1'])(
    'treats %s as public',
    (ip) => expect(isPrivateIp(ip)).toBe(false),
  )
})

describe('GeolocationService.resolveClientIp', () => {
  const geo = new GeolocationService({} as RedisService)

  it('keeps a T-Mobile USA address instead of swapping in a test IP', () => {
    expect(geo.resolveClientIp('172.58.1.1')).toBe('172.58.1.1')
  })

  it('skips private hops in X-Forwarded-For', () => {
    expect(geo.resolveClientIp('10.0.0.5, 203.0.113.9')).toBe('203.0.113.9')
  })

  it('falls back to X-Real-IP', () => {
    expect(geo.resolveClientIp(undefined, '203.0.113.9')).toBe('203.0.113.9')
  })

  it('returns null when there is no public IP', () => {
    expect(geo.resolveClientIp('192.168.0.2', '127.0.0.1')).toBeNull()
    expect(geo.resolveClientIp()).toBeNull()
  })
})
