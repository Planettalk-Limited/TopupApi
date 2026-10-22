# TopupApi

Standalone backend API for [TopupApp](../TopupApp) (PlanetTalk's mobile top-up/airtime web app).

Started as the home for the **PlanetTalk Creditback claim** endpoint — TopupApp has no
database of its own (order state lives in Stripe metadata), so this is the first piece
of durable, queryable backend storage for that ecosystem. More TopupApp logic can move
here over time; see `TopupApp`'s repo for the fuller backend-gaps assessment.

## Stack

- [NestJS 10](https://nestjs.com/) + TypeScript
- Prisma 7 (`@prisma/adapter-pg` driver adapter) against PostgreSQL 16
- `@nestjs/throttler` for per-route rate limiting
- Docker Compose + Traefik, matching the same deployment pattern as `TopupApp` and
  the org's other backends (see `roja-backend` for the fuller reference version of
  this same pattern)

## Local development

```bash
npm install
cp .env.example .env
# edit .env — point DATABASE_URL at a local Postgres, or run one via Docker:
docker run -d --name topup-api-postgres-dev -e POSTGRES_PASSWORD=dev -p 5432:5432 postgres:16-alpine
npx prisma migrate deploy
npm run start:dev
```

API is served under `/api` (e.g. `GET http://localhost:3000/api/health`).

## Deployment

Designed to run as two extra containers (`app`, `postgres`) on the **same droplet**
that already runs TopupApp + Traefik — no new droplet needed. See `docker-compose.yml`
for the full stack; Postgres is deliberately memory-tuned (`shared_buffers=64MB`) for
a small, shared droplet.

```bash
# On the server, alongside the TopupApp checkout:
git clone git@github-planettalk:Planettalk-Limited/TopupApi.git
cd TopupApi
make setup            # creates .env.production from .env.example — edit it
make up                # builds + starts postgres and the API, runs migrations on boot
make logs              # tail logs
```

Before going live, update the Traefik `Host(...)` rule in `docker-compose.yml` to the
real subdomain you want this API reachable on, and set `CORS_ORIGIN` in
`.env.production` to TopupApp's real origin(s) — the API rejects browser requests
from any origin not explicitly listed there.

## Endpoints

- `GET /api/health` — liveness + DB connectivity check (used by the Docker health check)
- `POST /api/creditback/claim` — public, rate-limited (5 requests / 10 min / IP).
  Body: `{ phone, countryCode, email, transactionValue, transactionCurrency, transactionId?, locale? }`.
  `countryCode` is restricted server-side to `GB | US | CA | FR | IE` regardless of
  what the client sends — see `src/creditback/dto/create-claim.dto.ts`.

There is currently no admin UI for reviewing submitted claims — query the
`creditback_claims` table directly (`make db-shell`) until there's appetite for one.

### Gift vouchers & groceries (buhibab / SureGifts, Nigeria)

Off unless `GIFT_VOUCHERS_ENABLED=true`, which must match the frontend's
`NEXT_PUBLIC_GIFT_VOUCHERS_ENABLED`. While off, these routes 404.

- `GET /api/planettalk/vouchers?category=groceries|gift`: public catalogue (omit `category` for
  both). Built in `src/providers/buhibab/voucher.service.ts` from buhibab's "Gift Vouchers"
  sub-service, cached for 60s. Each voucher has `id, name, category, tags, supplier, logo,
  minAmount, maxAmount, currency`.
  - `logo` is buhibab's product `image_url`, a whole card design at about 16:10. It is
    deliberately not `operator_logo`: the operator is SureGifts for every voucher, so that would
    put the same logo on every brand.
- `POST /api/payments/vouchers/quote`: rate-limited (30 / min). Re-prices against the catalogue;
  the client never sends a price.
- Purchase runs through the payments fulfilment engine (`PlanetTalkVoucherExecutor`). The voucher
  code, when buhibab returns one, is read back with `GET /api/payments/gift-card-code`.

Running it locally:

```bash
rm -f tsconfig.tsbuildinfo   # a stale one makes `nest build` emit no dist/
npx nest build
CORS_ORIGIN=http://localhost:3000,http://localhost:3002 GIFT_VOUCHERS_ENABLED=true node --env-file=.env dist/main
```

`--env-file` is needed because `PLANETTALK_CONFIG` reads the credentials before Nest's
`ConfigModule` loads `.env`. Without it the catalogue answers 503 "credentials not configured".

⚠️ buhibab allows **one login token per account**, and every login cancels the previous one. A
local backend using the live credentials cancels production's token when it logs in. Production
retries and logs back in, but don't leave a local backend running against live credentials.

### Careers

- `GET /api/careers/jobs` — public, list open postings.
- `GET /api/careers/jobs/:id` — public, single posting by id (any status).
- `GET /api/careers/jobs/slug/:slug` — public, single posting by slug (any status).
- `POST /api/careers/jobs/:id/apply` — public, rate-limited (5 requests / 10 min / IP,
  same as `creditback/claim`). Multipart, with a `cv` file field (PDF/DOC/DOCX, 5MB max).
- `GET/POST/PATCH/DELETE /api/admin/job-postings` — admin (any authenticated admin, not
  SUPERADMIN-restricted).
- `GET/PATCH/POST/DELETE /api/admin/job-applications` — admin (list, `:id/status`,
  `:id/reject`, `:id`), plus `GET /api/admin/job-applications/:id/cv` for the CV download.
