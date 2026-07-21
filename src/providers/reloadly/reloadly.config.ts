/**
 * Centralized Reloadly API configuration. Ported verbatim from TopupApp's
 * src/lib/reloadly-config.ts. Sandbox vs production is chosen purely by the
 * `audience` claim / host; the auth endpoint itself is the same for both.
 */

export type ReloadlyApi = 'giftcards' | 'topups' | 'utilities'

const IS_SANDBOX = process.env.RELOADLY_SANDBOX === 'true'

export const RELOADLY_CONFIG = {
  isSandbox: IS_SANDBOX,
  urls: {
    auth: 'https://auth.reloadly.com/oauth/token',
    giftcards: IS_SANDBOX ? 'https://giftcards-sandbox.reloadly.com' : 'https://giftcards.reloadly.com',
    topups: IS_SANDBOX ? 'https://topups-sandbox.reloadly.com' : 'https://topups.reloadly.com',
    utilities: IS_SANDBOX ? 'https://utilities-sandbox.reloadly.com' : 'https://utilities.reloadly.com',
  },
  audiences: {
    giftcards: IS_SANDBOX ? 'https://giftcards-sandbox.reloadly.com' : 'https://giftcards.reloadly.com',
    topups: IS_SANDBOX ? 'https://topups-sandbox.reloadly.com' : 'https://topups.reloadly.com',
    utilities: IS_SANDBOX ? 'https://utilities-sandbox.reloadly.com' : 'https://utilities.reloadly.com',
  },
  credentials: {
    clientId: process.env.RELOADLY_CLIENT_ID,
    clientSecret: process.env.RELOADLY_CLIENT_SECRET,
  },
  token: {
    refreshBuffer: 5 * 60 * 1000, // refresh 5 min before expiry
    defaultExpiry: 86400, // seconds
  },
} as const

export function getReloadlyUrl(api: ReloadlyApi): string {
  return RELOADLY_CONFIG.urls[api]
}

export function getReloadlyAudience(api: ReloadlyApi): string {
  return RELOADLY_CONFIG.audiences[api]
}

export function hasReloadlyCredentials(): boolean {
  return !!(RELOADLY_CONFIG.credentials.clientId && RELOADLY_CONFIG.credentials.clientSecret)
}
