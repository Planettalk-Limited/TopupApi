import {
  deriveLinkToken,
  hashLinkToken,
  isWellFormedToken,
  linkTokenSecret,
  newSubmissionReference,
  newTokenSalt,
  tokenMatches,
} from './gift-token'

const SECRET = 'test-secret-value'

function row(id = 'ent-1', salt = newTokenSalt(), secret = SECRET) {
  const token = deriveLinkToken(secret, id, salt)
  return { token, row: { id, tokenSalt: salt, tokenHash: hashLinkToken(token) } }
}

describe('gift link tokens', () => {
  it('derives a 43-char base64url token that carries no ids', () => {
    const { token } = row('5f0c1f8e-customer-order-ids')
    expect(isWellFormedToken(token)).toBe(true)
    expect(token).toHaveLength(43)
    expect(token).not.toContain('5f0c1f8e')
  })

  it('stores only a sha256 hash, never the raw token', () => {
    const { token, row: r } = row()
    expect(r.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(r.tokenHash).not.toContain(token)
  })

  it('is unique per entitlement and per salt', () => {
    const a = row('ent-1', 'salt-a').token
    expect(row('ent-2', 'salt-a').token).not.toBe(a)
    expect(row('ent-1', 'salt-b').token).not.toBe(a)
    expect(newTokenSalt()).not.toBe(newTokenSalt())
  })

  it('accepts the genuine token', () => {
    const { token, row: r } = row()
    expect(tokenMatches(SECRET, token, r)).toBe(true)
  })

  it('rejects a token whose hash does not match the row', () => {
    const { row: r } = row()
    const other = row('ent-2').token
    expect(tokenMatches(SECRET, other, r)).toBe(false)
  })

  it('rejects a token with one character changed', () => {
    const { token, row: r } = row()
    const flipped = token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A')
    expect(tokenMatches(SECRET, flipped, r)).toBe(false)
  })

  it('rejects every outstanding link once the secret is rotated', () => {
    const { token, row: r } = row()
    expect(tokenMatches('rotated-secret', token, r)).toBe(false)
  })

  it('rejects a row whose stored hash was tampered to match a forged token', () => {
    const { row: r } = row()
    const forged = 'A'.repeat(43)
    expect(tokenMatches(SECRET, forged, { ...r, tokenHash: hashLinkToken(forged) })).toBe(false)
  })

  it('rejects malformed input before any comparison', () => {
    const { row: r } = row()
    for (const bad of ['', 'short', 'x'.repeat(44), 'a'.repeat(42) + '=', '../../etc/passwd', null, 42]) {
      expect(isWellFormedToken(bad)).toBe(false)
      expect(tokenMatches(SECRET, bad as string, r)).toBe(false)
    }
  })

  it('refuses to derive or match without a secret', () => {
    const { token, row: r } = row()
    expect(() => deriveLinkToken('', 'id', 'salt')).toThrow()
    expect(tokenMatches('', token, r)).toBe(false)
  })

  it('prefers GIFT_CAMPAIGN_TOKEN_SECRET and falls back to JWT_SECRET', () => {
    expect(linkTokenSecret({ GIFT_CAMPAIGN_TOKEN_SECRET: 'a', JWT_SECRET: 'b' })).toBe('a')
    expect(linkTokenSecret({ JWT_SECRET: 'b' })).toBe('b')
    expect(linkTokenSecret({})).toBe('')
  })

  it('makes readable submission references', () => {
    expect(newSubmissionReference()).toMatch(/^GFT-[0-9A-HJKMNP-TV-Z]{8}$/)
  })
})
