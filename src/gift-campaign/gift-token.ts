// Campaign link tokens.
//
// The link carries a 256-bit opaque token and nothing else — no customer id, phone or
// order reference. The DB stores only its SHA-256 (`tokenHash`, unique, used for lookup),
// exactly like customer password-reset tokens. Unlike those, the raw token is not random
// but an HMAC of (entitlement id, per-row random salt) under a server secret, so the
// signed-in customer's in-app view can re-derive the same link without the DB ever holding
// it. A DB leak alone yields neither tokens nor a way to compute them; rotating the secret
// invalidates every outstanding link.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'crypto'

/** base64url of a 32-byte HMAC: always 43 characters. */
export const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

export function newTokenSalt(): string {
  return randomBytes(16).toString('hex')
}

export function deriveLinkToken(secret: string, entitlementId: string, salt: string): string {
  if (!secret) throw new Error('Gift campaign token secret is not configured')
  return createHmac('sha256', secret).update(`gift-link:v1:${entitlementId}:${salt}`).digest('base64url')
}

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

/** Cheap shape check before any DB lookup, so junk never reaches the query. */
export function isWellFormedToken(token: unknown): token is string {
  return typeof token === 'string' && TOKEN_PATTERN.test(token)
}

/**
 * Constant-time check that a presented token belongs to this row: it must hash to the
 * stored hash AND be the token the current secret derives for the row (so a link minted
 * under a rotated-out secret stops working).
 */
export function tokenMatches(
  secret: string,
  presented: string,
  row: { id: string; tokenSalt: string; tokenHash: string },
): boolean {
  if (!isWellFormedToken(presented) || !secret) return false
  const presentedHash = Buffer.from(hashLinkToken(presented), 'hex')
  const storedHash = Buffer.from(row.tokenHash, 'hex')
  if (presentedHash.length !== storedHash.length || !timingSafeEqual(presentedHash, storedHash)) return false
  const expected = Buffer.from(deriveLinkToken(secret, row.id, row.tokenSalt))
  const given = Buffer.from(presented)
  return expected.length === given.length && timingSafeEqual(expected, given)
}

/** GFT- plus 8 Crockford base32 characters (no I, L, O, U): easy to read out over the phone. */
export function newSubmissionReference(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
  const bytes = randomBytes(8)
  let out = ''
  for (const b of bytes) out += alphabet[b % 32]
  return `GFT-${out}`
}

export function linkTokenSecret(env: Record<string, string | undefined> = process.env): string {
  return env.GIFT_CAMPAIGN_TOKEN_SECRET?.trim() || env.JWT_SECRET?.trim() || ''
}
