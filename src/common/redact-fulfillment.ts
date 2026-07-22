import { Prisma } from '@prisma/client'

// SECURITY: Fulfillment.meta carries plaintext provider secrets (gift-card
// cardCode/cardPin, redemption URLs) that admin surfaces must never render
// verbatim. Mask cardPin entirely and cardCode down to its last 4 characters;
// everything else (e.g. electricity token/units) is not sensitive in the same
// way and stays visible. Shared so every admin read path (orders list/detail,
// dashboard recentOrders) is covered by construction — no per-endpoint opt-in.
export function redactFulfillmentMeta(meta: Prisma.JsonValue | null | undefined): Prisma.JsonValue | null {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) {
    return meta ?? null
  }

  const redacted: Record<string, unknown> = { ...(meta as Record<string, unknown>) }

  if (typeof redacted.cardPin === 'string' && redacted.cardPin.length > 0) {
    redacted.cardPin = '••••'
  }

  if (typeof redacted.cardCode === 'string' && redacted.cardCode.length > 0) {
    const code = redacted.cardCode
    redacted.cardCode = code.length <= 4 ? '••••' : `••••${code.slice(-4)}`
  }

  return redacted as Prisma.JsonValue
}

export function redactFulfillment<T extends { meta: Prisma.JsonValue | null } | null>(
  fulfillment: T,
): T {
  if (!fulfillment) return fulfillment
  return { ...fulfillment, meta: redactFulfillmentMeta(fulfillment.meta) }
}
