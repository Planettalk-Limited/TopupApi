import { CustomerAuthController } from './customer-auth.controller'

// Every public account route must sit well under the global 60/min — they are the
// password-guessing, code-guessing and inbox-flooding surfaces.
describe('CustomerAuthController rate limits', () => {
  const routes = ['check', 'register', 'verifyEmail', 'resendVerification', 'login', 'forgotPassword', 'resetPassword'] as const

  it.each(routes)('%s has a tight per-route throttle', (route) => {
    const handler = CustomerAuthController.prototype[route]
    const limit = Reflect.getMetadata('THROTTLER:LIMITdefault', handler) as number | undefined
    const ttl = Reflect.getMetadata('THROTTLER:TTLdefault', handler) as number | undefined

    expect(limit).toBeDefined()
    expect(ttl).toBeDefined()
    // Requests per minute allowed by the route budget, strictly below the global 60/min.
    expect((limit! / ttl!) * 60_000).toBeLessThanOrEqual(5)
  })
})
