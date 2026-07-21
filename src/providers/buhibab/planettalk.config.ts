// Ported from TopupApp src/lib/planettalk-config.ts. buhibab ("PlanetTalk")
// has a single environment (no sandbox) and is Nigeria-only.

export const PLANETTALK_CONFIG = {
  url: process.env.PLANETTALK_API_URL || 'https://api.buhibab.com',
  credentials: {
    email: process.env.PLANETTALK_EMAIL,
    password: process.env.PLANETTALK_PASSWORD,
  },
  country: 'NG',
  token: {
    refreshBuffer: 5 * 60 * 1000, // refresh 5 min before expiry
  },
} as const

export function getPlanetTalkUrl(): string {
  return PLANETTALK_CONFIG.url
}

export function hasPlanetTalkCredentials(): boolean {
  return !!(PLANETTALK_CONFIG.credentials.email && PLANETTALK_CONFIG.credentials.password)
}
