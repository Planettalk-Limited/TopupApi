import { applyOutcome, CheckState, initialCheckState, Transition } from './check-state'

const fail = (at = new Date()) => ({ ok: false, error: 'HTTP 503', latencyMs: 10, at })
const pass = (at = new Date()) => ({ ok: true, latencyMs: 10, at })

/** Feed a sequence of outcomes ('F'/'P') and collect the transitions. */
function run(seq: string, threshold = 2): { state: CheckState; transitions: Transition[] } {
  let state = initialCheckState()
  const transitions: Transition[] = []
  for (const c of seq) {
    const r = applyOutcome(state, c === 'F' ? fail() : pass(), threshold)
    state = r.state
    transitions.push(r.transition)
  }
  return { state, transitions }
}

describe('applyOutcome (alert-on-transition)', () => {
  it('does not alert on a single failure below the threshold', () => {
    expect(run('F').transitions).toEqual([null])
  })

  it('alerts once when the threshold of consecutive failures is reached', () => {
    expect(run('FF').transitions).toEqual([null, 'down'])
  })

  it('stays quiet while a check stays down (no alert every run)', () => {
    expect(run('FFFFFF').transitions).toEqual([null, 'down', null, null, null, null])
  })

  it('sends one recovered transition when it passes again, then nothing', () => {
    expect(run('FFFPP').transitions).toEqual([null, 'down', null, 'recovered', null])
  })

  it('treats fail/pass/fail as flapping, not an outage', () => {
    expect(run('FPFPFP').transitions).toEqual([null, null, null, null, null, null])
  })

  it('does not send "recovered" for a failure that never alerted', () => {
    expect(run('FP').transitions).toEqual([null, null])
  })

  it('alerts again for a second outage after recovering', () => {
    expect(run('FFPFF').transitions).toEqual([null, 'down', 'recovered', null, 'down'])
  })

  it('honours a threshold of 1 (alert on first failure) and treats <1 as 1', () => {
    expect(run('F', 1).transitions).toEqual(['down'])
    expect(run('F', 0).transitions).toEqual(['down'])
  })

  it('honours a higher threshold', () => {
    expect(run('FFFF', 3).transitions).toEqual([null, null, 'down', null])
  })

  it('records the failure streak start and last error, and clears them on pass', () => {
    const t1 = new Date('2026-01-01T00:00:00Z')
    const t2 = new Date('2026-01-01T00:05:00Z')
    let { state } = applyOutcome(initialCheckState(), fail(t1), 2)
    state = applyOutcome(state, fail(t2), 2).state
    expect(state).toMatchObject({
      failingSince: t1,
      lastCheckedAt: t2,
      consecutiveFailures: 2,
      alerting: true,
      lastOk: false,
      lastError: 'HTTP 503',
    })
    state = applyOutcome(state, pass(), 2).state
    expect(state).toMatchObject({
      failingSince: null,
      consecutiveFailures: 0,
      alerting: false,
      lastOk: true,
      lastError: null,
    })
  })
})
