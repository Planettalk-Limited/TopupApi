// What the synthetic monitor actually checks.
//
// Each check replays a READ the customer site makes to render a product page, against the
// real API over HTTP (not by calling services in-process), so routing, guards, the
// controllers' own validation and the provider behind them are all exercised exactly as a
// browser would hit them. Paths mirror TopupApp's fetches (UtilityStore, GiftCardStore,
// VoucherStore, utility/page.tsx, healthcare/page.tsx).
//
// Hard rule: nothing here may place an order, create a payment intent or spend money. The
// only POSTs are the voucher/healthcare *quote* endpoints, which just price a basket (no
// DB write, no provider order).
import { Probe, ProbeError } from './http-probe'

export interface SyntheticCheck {
  /** Stable id, used as the state key and in the status endpoint. */
  id: string
  /** Human label for alert emails ("Utilities: Nigeria billers"). */
  label: string
  kind: 'api' | 'site'
  /** The URL(s) hit, shown in alerts and the status endpoint so ops can reproduce by hand. */
  target: string
  run(probe: Probe): Promise<void>
}

export interface SyntheticCheckConfig {
  /** Base of the API including the global prefix, e.g. http://127.0.0.1:3000/api. No trailing slash. */
  apiBaseUrl: string
  /** Base of the customer site, e.g. https://planettalk.com. No trailing slash. Empty disables page checks. */
  siteBaseUrl: string
  /** Other hostnames that must still serve (or redirect to) the homepage. */
  siteAliasUrls: string[]
  /** Who serves Nigerian top-ups/utilities. Mirrors TOPUP_PROVIDER_NG (and the frontend's NEXT_PUBLIC_ twin). */
  ngProvider: 'reloadly' | 'planettalk'
  /** A non-Nigeria country for the Reloadly operators check. */
  topupCountry: string
  /** A country that has allow-listed gift cards. */
  giftCardCountry: string
  vouchersEnabled: boolean
  healthcareEnabled: boolean
  /** Drug search term for the healthcare check; must return at least one priced drug. */
  healthcareQuery: string
}

function nonEmptyArray(body: unknown, what: string): unknown[] {
  if (!Array.isArray(body)) throw new ProbeError(`expected a list of ${what}, got ${typeof body}`)
  // An empty catalogue renders as a page with nothing to buy: broken, as far as a customer is concerned.
  if (body.length === 0) throw new ProbeError(`no ${what} returned`)
  return body
}

function positiveAmount(body: unknown, what: string): void {
  const amount = (body as { amount?: unknown } | null)?.amount
  if (typeof amount !== 'number' || !(amount > 0)) throw new ProbeError(`${what} returned no usable amount`)
}

function jsonListCheck(id: string, label: string, url: string, what: string): SyntheticCheck {
  return {
    id,
    label,
    kind: 'api',
    target: url,
    async run(probe) {
      nonEmptyArray(await probe.getJson(url), what)
    },
  }
}

function pageCheck(id: string, label: string, url: string): SyntheticCheck {
  return { id, label, kind: 'site', target: url, run: (probe) => probe.getPage(url) }
}

export function buildSyntheticChecks(cfg: SyntheticCheckConfig): SyntheticCheck[] {
  const api = cfg.apiBaseUrl
  // Same switch as TopupApp's getTopupApiPrefix/getUtilitiesApiPrefix.
  const ng = cfg.ngProvider === 'planettalk' ? 'planettalk' : 'reloadly'
  const checks: SyntheticCheck[] = [
    // Mobile top-up / data (homepage + /utility)
    jsonListCheck('topup-countries', 'Top-up: country list', `${api}/reloadly/topup-countries`, 'countries'),
    jsonListCheck(
      'topup-operators-ng',
      `Top-up: Nigeria operators (${ng})`,
      `${api}/${ng}/operators?countryCode=NG`,
      'operators',
    ),
    jsonListCheck(
      'topup-operators-intl',
      `Top-up: ${cfg.topupCountry} operators (reloadly)`,
      `${api}/reloadly/operators?countryCode=${cfg.topupCountry}`,
      'operators',
    ),
    // Utilities (/utilities)
    jsonListCheck('utility-countries', 'Utilities: country list', `${api}/reloadly/utility-countries`, 'countries'),
    jsonListCheck(
      'utility-billers-ng',
      `Utilities: Nigeria billers (${ng})`,
      `${api}/${ng}/billers?countryCode=NG`,
      'billers',
    ),
    // Gift cards (/gift-cards)
    jsonListCheck(
      'gift-card-countries',
      'Gift cards: country list',
      `${api}/reloadly/gift-cards/countries`,
      'countries',
    ),
    jsonListCheck(
      'gift-cards',
      `Gift cards: ${cfg.giftCardCountry} catalogue`,
      `${api}/reloadly/gift-cards?countryCode=${cfg.giftCardCountry}`,
      'gift cards',
    ),
  ]

  // Vouchers and healthcare 404 by design while their feature flag is off, so only check
  // them when they're live — otherwise we'd alert on a deliberate 404 forever.
  if (cfg.vouchersEnabled) {
    for (const category of ['groceries', 'gift'] as const) {
      const listUrl = `${api}/planettalk/vouchers?category=${category}`
      const quoteUrl = `${api}/payments/vouchers/quote`
      checks.push({
        id: `vouchers-${category}`,
        label: category === 'groceries' ? 'Groceries: voucher catalogue + quote' : 'Gift vouchers: catalogue + quote',
        kind: 'api',
        target: `${listUrl} then POST ${quoteUrl}`,
        async run(probe) {
          const [first] = nonEmptyArray(await probe.getJson(listUrl), `${category} vouchers`) as Array<{
            id: number
            minAmount: number
          }>
          // Pricing the cheapest denomination proves the checkout's price step works too.
          positiveAmount(
            await probe.postJson(quoteUrl, { productId: first.id, amount: Math.ceil(first.minAmount) }),
            'voucher quote',
          )
        },
      })
    }
  }

  if (cfg.healthcareEnabled) {
    const searchUrl = `${api}/planettalk/healthcare/drugs/search?query=${encodeURIComponent(cfg.healthcareQuery)}`
    const quoteUrl = `${api}/payments/healthcare/quote`
    checks.push({
      id: 'healthcare',
      label: 'Healthcare: drug search + quote',
      kind: 'api',
      target: `${searchUrl} then POST ${quoteUrl}`,
      async run(probe) {
        const [first] = nonEmptyArray(await probe.getJson(searchUrl), 'medications') as Array<{ drugName: string }>
        positiveAmount(
          await probe.postJson(quoteUrl, { drugs: [{ drugName: first.drugName, quantity: 1 }] }),
          'healthcare quote',
        )
      },
    })
  }

  if (cfg.siteBaseUrl) {
    const site = cfg.siteBaseUrl
    // The pages in TopupApp's product tabs (MobileProductTabs) plus /utility, the page the
    // homepage's top-up form lands on.
    const pages: Array<[string, string, string]> = [
      ['site-home', 'Website: homepage (top-up)', '/'],
      ['site-utility', 'Website: top-up / data page', '/utility'],
      ['site-utilities', 'Website: utilities page', '/utilities'],
      ['site-gift-cards', 'Website: gift cards page', '/gift-cards'],
      ['site-groceries', 'Website: groceries page', '/groceries'],
      ['site-make-calls', 'Website: make calls page', '/make-calls'],
    ]
    if (cfg.vouchersEnabled) pages.push(['site-gift-vouchers', 'Website: gift vouchers page', '/gift-vouchers'])
    if (cfg.healthcareEnabled) pages.push(['site-healthcare', 'Website: healthcare page', '/healthcare'])
    for (const [id, label, path] of pages) checks.push(pageCheck(id, label, `${site}${path}`))

    for (const alias of cfg.siteAliasUrls) {
      const host = alias.replace(/^https?:\/\//, '')
      checks.push(pageCheck(`site-alias-${host}`, `Website: ${host} homepage`, `${alias}/`))
    }
  }

  return checks
}
