# Synthetic monitoring ("is the site broken?")

Every 5 minutes the API replays what a customer's browser does to load each product page,
and emails ops when something stops working. The goal is to hear about a broken page before
customers do. Code: `src/monitoring/`.

## What it checks

API checks go to `SYNTHETIC_API_BASE_URL` (default `http://127.0.0.1:$PORT/api`, the API in
the same container). They are the same calls TopupApp makes. Each must return a **non-empty**
list, because a page with nothing to buy counts as broken.

| Check id | Request |
| --- | --- |
| `topup-countries` | `GET /reloadly/topup-countries` |
| `topup-operators-ng` | `GET /{reloadly or planettalk}/operators?countryCode=NG` (follows `TOPUP_PROVIDER_NG`) |
| `topup-operators-intl` | `GET /reloadly/operators?countryCode=GH` (`SYNTHETIC_TOPUP_COUNTRY`) |
| `utility-countries` | `GET /reloadly/utility-countries` |
| `utility-billers-ng` | `GET /{reloadly or planettalk}/billers?countryCode=NG` (follows `TOPUP_PROVIDER_NG`) |
| `gift-card-countries` | `GET /reloadly/gift-cards/countries` |
| `gift-cards` | `GET /reloadly/gift-cards?countryCode=US` (`SYNTHETIC_GIFT_CARD_COUNTRY`) |
| `vouchers-groceries`, `vouchers-gift` | `GET /planettalk/vouchers?category=…`, then `POST /payments/vouchers/quote` for the first voucher at its minimum amount. Only when `GIFT_VOUCHERS_ENABLED=true` |
| `healthcare` | `GET /planettalk/healthcare/drugs/search?query=paracetamol`, then `POST /payments/healthcare/quote` for the first drug, quantity 1. Only when `HEALTHCARE_ENABLED=true` |

Page checks `GET` the customer site at `SYNTHETIC_SITE_URL` (default `https://planettalk.com`)
and pass on a 2xx HTML page after following redirects:
`/`, `/utility`, `/utilities`, `/gift-cards`, `/groceries`, `/make-calls`, plus `/gift-vouchers`
and `/healthcare` when those features are on. Each host in `SYNTHETIC_SITE_ALIASES` (default
`https://www.planettalk.com,https://mobiletopup.planettalk.com`) gets a homepage check too.

The checks never place an order or create a payment. The only POSTs are the two quote
endpoints. They price a basket, write nothing and don't call a provider's order API.

## When it alerts

- A check counts as **down** after `SYNTHETIC_FAILURE_THRESHOLD` failures in a row (default 2,
  so about 10 minutes). A single blip does not alert.
- It sends **one** critical alert when a check goes down and **one** "recovered" alert when the
  check passes again. Nothing is sent in between.
- Checks that change state in the same run share one email, so a full outage sends one message.
- Alerts go through `AlertService`: email to `OPS_ALERT_EMAILS` and a post to
  `RELOADLY_ALERT_WEBHOOK_URL`.
- State is kept in memory. After a restart, a check that is still broken alerts again once.
  A check that recovered during the restart gets no "recovered" email. This works because the
  API runs as a single replica. With several replicas, move the state to Redis.

Live status (admin JWT): `GET /api/admin/monitoring/status`. It returns each check's `status`
(`pending | ok | failing | down`), last error, latency, and when it started failing.

## Configuration

| Env var | Default | Meaning |
| --- | --- | --- |
| `SYNTHETIC_MONITORING_ENABLED` | on when `NODE_ENV=production`, otherwise off | `true` / `false` overrides the default |
| `SYNTHETIC_INTERVAL_MINUTES` | `5` | How often the checks run |
| `SYNTHETIC_FAILURE_THRESHOLD` | `2` | Failures in a row before alerting |
| `SYNTHETIC_TIMEOUT_MS` | `15000` | Per-request timeout. A hung request counts as a failure |
| `SYNTHETIC_API_BASE_URL` | `http://127.0.0.1:$PORT/api` | Set `https://topupapi.planettalk.com/api` to also cover Traefik, TLS and DNS |
| `SYNTHETIC_SITE_URL` | `https://planettalk.com` | Customer site. Set it to empty to turn page checks off |
| `SYNTHETIC_SITE_ALIASES` | `https://www.planettalk.com,https://mobiletopup.planettalk.com` | Other hosts whose homepage must load |
| `SYNTHETIC_TOPUP_COUNTRY` | `GH` | Country for the Reloadly operators check |
| `SYNTHETIC_GIFT_CARD_COUNTRY` | `US` | Country for the gift-card catalogue check |
| `SYNTHETIC_HEALTHCARE_QUERY` | `paracetamol` | Drug search term. It must return at least one priced drug |

## Adding someone to the alerts (e.g. PlanetTalk marketing)

`OPS_ALERT_EMAILS` is a comma-separated list. To add a recipient:

1. Append their address to `OPS_ALERT_EMAILS` in `.env.production` on the server, e.g.
   `OPS_ALERT_EMAILS=ops@example.com,abraham@planettalk.com`.
2. Restart the API container: `docker compose up -d app`.

The list is shared by every operational alert: fulfilment failures, low provider balance,
disputes and these monitor alerts. Anyone on it gets all of those.

## Limits

- The monitor runs inside the API container. If the whole droplet or container is down,
  nothing alerts. An external uptime service watching `https://topupapi.planettalk.com/api/health`
  and `https://planettalk.com/` covers that case.
- Page checks see the server-rendered HTML. They catch outages, 5xx errors, bad deploys and
  broken redirects. They do not catch a JavaScript error that only happens in the browser after
  the page loads. The API checks cover the data those pages load, which is how most
  "page shows nothing" breakages appear.
- Each run makes about 10 provider catalogue calls (Reloadly/buhibab). They appear in the
  provider call log and the admin provider-health stats.
