import { PlanetTalkService } from './planettalk.service'

jest.mock('./planettalk.config', () => ({
  PLANETTALK_CONFIG: {
    url: 'https://api',
    credentials: { email: 'x@example.com', password: 'x' },
    country: 'NG',
    token: { refreshBuffer: 5 * 60 * 1000 },
  },
  getPlanetTalkUrl: () => 'https://api',
  hasPlanetTalkCredentials: () => true,
}))

// buhibab allows one live token per account — each login revokes the last. These tests
// model that and check the service never stampedes into self-revoking logins.

function fakeRedis(opts: { down?: boolean } = {}) {
  const store = new Map<string, string>()
  return {
    get: jest.fn(async (k: string) => (opts.down ? null : store.get(k) ?? null)),
    setPx: jest.fn(async (k: string, v: string) => {
      if (!opts.down) store.set(k, v)
    }),
    del: jest.fn(async (k: string) => void store.delete(k)),
    store,
  }
}

/** A buhibab stand-in: login mints token N and revokes N-1; any other URL 401s a stale token. */
function fakeBuhibab() {
  let n = 0
  let live = ''
  const calls = { logins: 0 }
  const impl = jest.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/auth/token')) {
      calls.logins++
      await new Promise((r) => setTimeout(r, 5))
      live = `tok-${++n}`
      return {
        ok: true,
        status: 200,
        json: async () => ({ token: live, expires_at: new Date(Date.now() + 3_600_000).toISOString() }),
      }
    }
    const auth = (init?.headers as Record<string, string>)?.Authorization
    return { ok: auth === `Bearer ${live}`, status: auth === `Bearer ${live}` ? 200 : 401, json: async () => ({}) }
  })
  return { impl, calls, revokeCurrent: () => (live = 'revoked-elsewhere') }
}

describe('PlanetTalkService token handling', () => {
  const realFetch = global.fetch
  let buhibab: ReturnType<typeof fakeBuhibab>

  beforeEach(() => {
    buhibab = fakeBuhibab()
    global.fetch = buhibab.impl as any
  })
  afterAll(() => {
    global.fetch = realFetch
  })

  it('logs in once for many concurrent requests on a cold cache', async () => {
    const svc = new PlanetTalkService(fakeRedis() as any)
    const results = await Promise.all(Array.from({ length: 8 }, () => svc.fetch('https://api/x')))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(buhibab.calls.logins).toBe(1)
  })

  it('still logs in only once when Redis is down (in-memory token)', async () => {
    const svc = new PlanetTalkService(fakeRedis({ down: true }) as any)
    await Promise.all(Array.from({ length: 8 }, () => svc.fetch('https://api/x')))
    await svc.fetch('https://api/x')
    expect(buhibab.calls.logins).toBe(1)
  })

  it('recovers from a token revoked elsewhere with a single re-login', async () => {
    const svc = new PlanetTalkService(fakeRedis() as any)
    await svc.fetch('https://api/x')
    buhibab.revokeCurrent()

    const results = await Promise.all(Array.from({ length: 5 }, () => svc.fetch('https://api/x')))
    expect(results.every((r) => r.status === 200)).toBe(true)
    expect(buhibab.calls.logins).toBe(2)
  })
})
