import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { SchedulerRegistry } from '@nestjs/schedule'
import { AlertService } from '../common/alert.service'
import { PROBE_USER_AGENT } from './http-probe'
import { SYNTHETIC_INTERVAL_NAME, SyntheticMonitorService } from './synthetic-monitor.service'

const HTML = `<!doctype html><html><body>${'x'.repeat(1000)}</body></html>`

function makeService(env: Record<string, string> = {}) {
  const values: Record<string, string> = { SYNTHETIC_MONITORING_ENABLED: 'true', ...env }
  const config = { get: (key: string) => values[key] } as unknown as ConfigService
  const alerts = { notify: jest.fn().mockResolvedValue(undefined) }
  const scheduler = {
    addInterval: jest.fn(),
    doesExist: jest.fn().mockReturnValue(false),
    deleteInterval: jest.fn(),
  }
  const service = new SyntheticMonitorService(
    config,
    alerts as unknown as AlertService,
    scheduler as unknown as SchedulerRegistry,
  )
  return { service, alerts, scheduler }
}

describe('SyntheticMonitorService', () => {
  // Every failing check logs a warning; keep the test output readable.
  beforeAll(() => Logger.overrideLogger(false))
  afterAll(() => Logger.overrideLogger(['log', 'error', 'warn', 'debug', 'verbose']))

  const realFetch = global.fetch
  /** URLs that currently answer 503; everything else is healthy. */
  let broken: Set<string>
  let fetchMock: jest.Mock

  beforeEach(() => {
    broken = new Set()
    fetchMock = jest.fn(async (url: string) => {
      if (broken.has(url) || [...broken].some((b) => b === '*')) {
        return new Response('upstream down', { status: 503 })
      }
      if (url.includes('/api/')) {
        return new Response(JSON.stringify([{ id: 1 }]), { headers: { 'content-type': 'application/json' } })
      }
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    })
    global.fetch = fetchMock as unknown as typeof fetch
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  describe('wiring', () => {
    it('is off by default outside production and schedules nothing', () => {
      const { service, scheduler } = makeService({ SYNTHETIC_MONITORING_ENABLED: '', NODE_ENV: 'development' })
      service.onModuleInit()
      expect(service.enabled).toBe(false)
      expect(scheduler.addInterval).not.toHaveBeenCalled()
    })

    it('is on by default in production', () => {
      expect(makeService({ SYNTHETIC_MONITORING_ENABLED: '', NODE_ENV: 'production' }).service.enabled).toBe(true)
    })

    it('can be switched off in production', () => {
      expect(makeService({ SYNTHETIC_MONITORING_ENABLED: 'false', NODE_ENV: 'production' }).service.enabled).toBe(
        false,
      )
    })

    it('registers an interval at the configured cadence', () => {
      jest.useFakeTimers()
      try {
        const { service, scheduler } = makeService({ SYNTHETIC_INTERVAL_MINUTES: '7' })
        const run = jest.spyOn(service, 'runOnce').mockResolvedValue()
        service.onModuleInit()
        expect(scheduler.addInterval).toHaveBeenCalledWith(SYNTHETIC_INTERVAL_NAME, expect.anything())
        jest.advanceTimersByTime(7 * 60_000 - 1)
        expect(run).not.toHaveBeenCalled()
        jest.advanceTimersByTime(1)
        expect(run).toHaveBeenCalledTimes(1)
        clearInterval(scheduler.addInterval.mock.calls[0][1])
      } finally {
        jest.useRealTimers()
      }
    })

    it('defaults: 5 minutes, threshold 2, API on this container, site at planettalk.com', () => {
      const { service } = makeService({ PORT: '3001' })
      expect(service.intervalMinutes).toBe(5)
      expect(service.failureThreshold).toBe(2)
      const targets = service.checks.map((c) => c.target)
      expect(targets).toContain('http://127.0.0.1:3001/api/reloadly/topup-countries')
      expect(targets).toContain('https://planettalk.com/utilities')
      expect(targets).toContain('https://mobiletopup.planettalk.com/')
    })

    it('honours URL overrides and an empty site URL disables page checks', () => {
      const { service } = makeService({
        SYNTHETIC_API_BASE_URL: 'https://topupapi.planettalk.com/api/',
        SYNTHETIC_SITE_URL: '',
      })
      expect(service.checks.every((c) => c.kind === 'api')).toBe(true)
      expect(service.checks[0].target).toBe('https://topupapi.planettalk.com/api/reloadly/topup-countries')
    })
  })

  describe('runOnce', () => {
    it('stays silent while everything passes and reports ok', async () => {
      const { service, alerts } = makeService()
      await service.runOnce()
      expect(alerts.notify).not.toHaveBeenCalled()
      const status = service.status()
      expect(status.summary.ok).toBe(status.summary.total)
      expect(fetchMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ headers: expect.objectContaining({ 'User-Agent': PROBE_USER_AGENT }) }),
      )
    })

    it('alerts once after N consecutive failures, never repeats, then sends one recovery', async () => {
      const { service, alerts } = makeService()
      const billers = 'http://127.0.0.1:3000/api/reloadly/billers?countryCode=NG'
      broken.add(billers)

      await service.runOnce() // failure 1: below threshold
      expect(alerts.notify).not.toHaveBeenCalled()
      expect(service.status().checks.find((c) => c.id === 'utility-billers-ng')?.status).toBe('failing')

      await service.runOnce() // failure 2: DOWN
      expect(alerts.notify).toHaveBeenCalledTimes(1)
      const [message, severity] = alerts.notify.mock.calls[0]
      expect(severity).toBe('critical')
      expect(message).toContain('Utilities: Nigeria billers (reloadly)')
      expect(message).toContain(billers)
      expect(message).toContain('HTTP 503')
      expect(service.status().checks.find((c) => c.id === 'utility-billers-ng')?.status).toBe('down')

      await service.runOnce() // still down: no repeat
      await service.runOnce()
      expect(alerts.notify).toHaveBeenCalledTimes(1)

      broken.clear()
      await service.runOnce() // recovered
      expect(alerts.notify).toHaveBeenCalledTimes(2)
      expect(alerts.notify.mock.calls[1][1]).toBe('info')
      expect(alerts.notify.mock.calls[1][0]).toContain('RECOVERED')
      expect(alerts.notify.mock.calls[1][0]).toContain('Utilities: Nigeria billers (reloadly)')

      await service.runOnce()
      expect(alerts.notify).toHaveBeenCalledTimes(2)
    })

    it('folds a full outage into a single email', async () => {
      const { service, alerts } = makeService()
      broken.add('*')
      await service.runOnce()
      await service.runOnce()
      expect(alerts.notify).toHaveBeenCalledTimes(1)
      expect(alerts.notify.mock.calls[0][0]).toContain(`${service.checks.length} checks are FAILING`)
      expect(service.status().summary.down).toBe(service.checks.length)
    })

    it('treats a network error or timeout as a failure, not a crash', async () => {
      const { service, alerts } = makeService({ SYNTHETIC_FAILURE_THRESHOLD: '1', SYNTHETIC_SITE_URL: '' })
      fetchMock.mockRejectedValue(new TypeError('fetch failed'))
      await expect(service.runOnce()).resolves.toBeUndefined()
      expect(alerts.notify).toHaveBeenCalledTimes(1)
      expect(alerts.notify.mock.calls[0][0]).toContain('request failed: fetch failed')
    })

    it('skips a tick while the previous run is still going', async () => {
      const { service } = makeService({ SYNTHETIC_SITE_URL: '' })
      let release!: () => void
      fetchMock.mockImplementationOnce(
        () => new Promise((resolve) => (release = () => resolve(new Response('[{"id":1}]')))),
      )
      const first = service.runOnce()
      await service.runOnce() // returns immediately
      expect(fetchMock).toHaveBeenCalledTimes(1)
      release()
      await first
      expect(service.status().running).toBe(false)
    })

    it('starts every check as pending before the first run', () => {
      const { service } = makeService()
      expect(service.status().summary.pending).toBe(service.checks.length)
    })
  })
})
