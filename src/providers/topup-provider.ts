// Server-side provider switch. Ported from TopupApp src/lib/topup-provider.ts,
// but reads TOPUP_PROVIDER_NG (a normal server env var) instead of the
// NEXT_PUBLIC_ build-time client var. Consulted by catalog endpoints today and
// by the fulfillment executor for Nigeria orders in Phase 4.

export type TopupProvider = 'reloadly' | 'planettalk'

const PROVIDER_NG: TopupProvider =
  (process.env.TOPUP_PROVIDER_NG as TopupProvider) || 'reloadly'

export function getTopupProvider(countryCode: string): TopupProvider {
  if (countryCode.toUpperCase() === 'NG') return PROVIDER_NG
  return 'reloadly'
}
