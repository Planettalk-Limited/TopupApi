// Alert-on-transition state machine for the synthetic checks.
//
// Kept Nest-free and pure so the "when do we email someone" rules can be unit-tested
// exhaustively without timers, HTTP or mocks. The rules:
//   - A check only counts as DOWN after `threshold` consecutive failures. One blip (a slow
//     provider, a deploy restarting the container) must not wake anyone up.
//   - We alert exactly once when it goes DOWN, and exactly once when it next passes
//     ("recovered"). Nothing in between: a check that stays broken for 3 hours sends one
//     email, not 36.
//   - A single pass resets the failure streak. A check that fails, passes, fails never
//     reaches the threshold, which is the point (that's flapping, not an outage).

export interface CheckState {
  /** Failures in a row since the last pass. */
  consecutiveFailures: number
  /** True once we've sent the DOWN alert and until we've sent the recovered one. */
  alerting: boolean
  lastCheckedAt: Date | null
  lastOk: boolean | null
  lastError: string | null
  lastLatencyMs: number | null
  /** When the current failure streak began (first failed run), for the status page and the recovery message. */
  failingSince: Date | null
}

export type Transition = 'down' | 'recovered' | null

export interface CheckOutcome {
  ok: boolean
  error?: string
  latencyMs: number
  at: Date
}

export function initialCheckState(): CheckState {
  return {
    consecutiveFailures: 0,
    alerting: false,
    lastCheckedAt: null,
    lastOk: null,
    lastError: null,
    lastLatencyMs: null,
    failingSince: null,
  }
}

/** Fold one run's outcome into the state and say whether that run crossed a boundary worth alerting on. */
export function applyOutcome(
  prev: CheckState,
  outcome: CheckOutcome,
  threshold: number,
): { state: CheckState; transition: Transition } {
  const base = {
    lastCheckedAt: outcome.at,
    lastOk: outcome.ok,
    lastLatencyMs: outcome.latencyMs,
  }

  if (outcome.ok) {
    return {
      state: { ...base, consecutiveFailures: 0, alerting: false, lastError: null, failingSince: null },
      transition: prev.alerting ? 'recovered' : null,
    }
  }

  const consecutiveFailures = prev.consecutiveFailures + 1
  const goesDown = !prev.alerting && consecutiveFailures >= Math.max(1, threshold)
  return {
    state: {
      ...base,
      consecutiveFailures,
      alerting: prev.alerting || goesDown,
      lastError: outcome.error ?? 'unknown error',
      failingSince: prev.failingSince ?? outcome.at,
    },
    transition: goesDown ? 'down' : null,
  }
}
