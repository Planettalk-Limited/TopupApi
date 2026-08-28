/**
 * Retry ceiling shared by the fulfilment orchestrator, the reconciliation worker and the
 * incident-triage tooling.
 *
 * Kept in its own Nest-free module so a standalone script (src/scripts/*) can import it
 * without pulling in @nestjs/schedule, Prisma and the alerting service — the production
 * image runs those scripts as plain `node dist/...`.
 */

// Matches the orchestrator's retry ceiling. Once a Fulfillment has failed this many
// times we stop auto-retrying it (further attempts are almost certainly a
// permanent/non-retryable condition) and alert instead.
export const MAX_ATTEMPTS = 5
