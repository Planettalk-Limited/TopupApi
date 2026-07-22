# TopupApi Migration — Phase 4 & 5 Handover

> **Goal of the next session:** move the **payment + fulfilment** flow out of the
> TopupApp frontend and into the TopupApi backend, so every top-up/gift-card/utility
> purchase is charged, delivered, and **recorded in the backend DB** (Order /
> Fulfillment / ProviderCallLog) — giving a real audit trail and a working admin
> Orders view. This file is self-contained: a fresh session should be able to start
> from here.

> ⚠️ **Keep this file local.** It is git-ignored (contains infra/host details). The
> TopupApi repo is **public** — never commit secrets or this file.

---

## 0. Repos & machines

| Thing | Location |
|---|---|
| Backend (NestJS) | `C:\Projects\Backend\TopupApi` → `git@github-planettalk:Planettalk-Limited/TopupApi.git` (**public**) |
| Frontend (Next.js 14) | `C:\Projects\Frontend\TopupApp` → `git@github-planettalk:Planettalk-Limited/TopupApp.git` (**private**) |
| Droplet | `138.68.155.21`, host `agent`, user `devop`. SSH aliases (WSL `~/.ssh/config`): `planettalk-devop` (devop), `planettalk` (root, key not installed) |
| Deploy dirs | `~/deployments/topupapi/application` (API), `~/deployments/topup/application` (frontend), `~/deployments/api/application` (agent portal — Mailgun source), `~/deployments/proxy/application` (traefik) |

### Git push identity (important — two GitHub accounts)
- Windows/Git-Bash default key `id_ed25519` = account **`NeilBvungidzire`** → **no write** to these org repos.
- WSL key `~/.ssh/id_ed25519_github` = account **`neilBv`** → **has write**. Alias `github-neilbv` added in WSL.
- **To push:** from WSL, e.g.
  ```bash
  git -C /mnt/c/Projects/Backend/TopupApi -c safe.directory='*' \
    push git@github-neilbv:Planettalk-Limited/TopupApi.git <branch>:<remote-branch>
  ```
- The droplet **pulls over public HTTPS** for TopupApi (no key needed) and via deploy key `github-topupapp` for the private TopupApp.
- **Frontend workflow:** push to `develop`, open PR `develop → main`, then deploy from `main`. Do **not** push straight to frontend `main`.

### Note on tooling / classifier
- The auto-mode safety classifier **blocks production-mutating commands** (git push, `docker compose up` on the droplet, ssh-config edits). In this project those steps were handed to the user to run; read-only checks (curl, `docker compose ps/logs`, `git log`) run fine. Expect to do the same.
- No `gh` CLI available (Windows or WSL).

---

## 1. Current production state (as of 2026-07-21)

### TopupApi — ✅ LIVE
- `https://topupapi.planettalk.com/api/health` → `200 {"status":"ok","database":"ok"}` (TLS via traefik `letsencrypt`).
- Containers (compose project `topup-api`, dir `~/deployments/topupapi/application`): `topup-api` (app), `topup-api-postgres` (16, internal only), `topup-api-redis` (7, internal only). All healthy.
- Own DB/redis (the agent-portal stack already owns host `:5432/:6379/:3001` — do **not** collide).
- Migrations applied: `20260721000000_init`, `20260721010000_orders_admin_audit`.
- First admin seeded: `itsupport@planettalk.com` (SUPERADMIN). Password = `ADMIN_SEED_PASSWORD` in `~/deployments/topupapi/.env.production`. Re-seed/reset: `docker compose exec app node prisma/seed-admin.js`.
- `main` branch = commit lineage foundation→phase-2→phase-3→admin-console→deploy fixes.
- Adminer at `warehouse.planettalk.com` uses traefik middleware `dash-auth@docker` (basic-auth, user `admin`, from `~/deployments/proxy/application/traefik/htpasswd`). Adminer service may still need `docker compose up -d adminer`.

### TopupApp — features staged, deploy via PR
- Live container `mobile-topup-frontend-prod` at `mobiletopup.planettalk.com`.
- New work (creditback popup, DB-backed admin panel, full admin console UI, buhibab email/meta fix, `NEXT_PUBLIC_*` build wiring) is on branch **`feat/admin-console`**, fast-forwards **`develop`**. Awaiting PR `develop → main` + `make deploy`.

---

## 2. THE SPLIT — what already goes via the API vs what does not

### Via TopupApi today (only these)
1. **Creditback claims** — `CreditbackClaimForm.tsx` → `POST /api/creditback/claim` (`NEXT_PUBLIC_CREDITBACK_API_URL`).
2. **Admin console** — `src/lib/admin-api.ts` → `/api/admin/*` (`NEXT_PUBLIC_API_URL`).

### Still 100% in the frontend (Next.js `/api/*` route handlers) — THIS IS WHAT PHASE 4/5 MOVES
- **Payment:** `src/app/api/stripe/{create-payment-intent,verify-payment,webhook}/route.ts`
- **Fulfilment orchestration:** `src/app/api/fulfill/route.ts`, `src/lib/client/fulfill-order.ts`, `src/lib/fulfillment/fulfill-payment-intent.ts`, `guard.ts`
- **Provider executors:** `src/lib/fulfillment/{reloadly-topup,reloadly-gift-card,reloadly-pay-bill,planettalk-topup,planettalk-pay-bill}.ts`
- **Pricing / signing / metadata:** `src/lib/fulfillment/{pricing,signature,metadata}.ts`
- **Catalog/geo/currency (read):** `src/app/api/{reloadly,planettalk,currency,geolocation}/**` (backend already has read-only equivalents built in Phase 2–3 but frontend still calls its own).

### Consequence in the admin console right now
- **Creditback** tab shows **real data** (claims hit the backend). ✅
- **Orders / Dashboard / Providers / Audit** are **empty in prod** — nothing writes `Order`/`Fulfillment`/`ProviderCallLog` yet. They populate only after Phase 4.

---

## 3. What the backend already has (build on this — don't rebuild)

- **DB models (Prisma, `prisma/schema.prisma`):** `Order`, `Fulfillment` (UNIQUE `orderId`, has `processingClaimedAt` for the SELECT…FOR UPDATE lock), `ProviderCallLog`, `CreditbackClaim`, `AdminUser`(+`AdminRole`), `AdminAuditLog`, `FxRateCache`. **Phase 4 mostly just needs to write these rows — the schema is ready.**
- **Provider services (read/catalog):** `src/providers/reloadly/reloadly.service.ts` (+ config, catalog controller, allowed-gift-card-products), `src/providers/buhibab/planettalk.service.ts` (+ config, mappers, types, ng-operators). Auth/token handling for both is already ported. **Purchase/fulfil methods are NOT yet on these services — that's the port.**
- **Currency:** `src/currency/*` (static FX table ported verbatim — this is the source of charged prices, not the live-rate cache).
- **Geo:** `src/geolocation/*`.
- **Admin retry stub:** `src/admin/admin-orders.service.ts#retry()` currently returns `not_implemented_phase1` and only audits. **Phase 4 wires it to the real fulfilment engine.**
- **Common:** `src/common/{prisma,redis,alert}.service.ts`, `all-exceptions.filter.ts`. Alerts (Mailgun EU + webhook) are ops-only, no-op if unset.

---

## 4. PHASE 4 — port payment + fulfilment to the backend (high-risk, own session)

**Server-authoritative model to preserve exactly (it's how the frontend works today):**
1. Client asks backend to create a Stripe **PaymentIntent**; backend computes price server-side from the **static FX table** (`src/currency`) × provider cost × markup — never trust client price. It stamps the order details into PI **metadata** and an HMAC **signature** (`src/lib/fulfillment/signature.ts` logic) so the webhook can trust them. Also **create an `Order` row (status `CREATED`)** now (new vs frontend, which only used PI metadata).
2. Stripe **webhook** (`payment_intent.succeeded`) → verify signature → mark `Order` `PAID` → **claim the `Fulfillment` row with `SELECT … FOR UPDATE`** (replaces the frontend's non-atomic Stripe-metadata "processing" lock) → call the provider executor → on success `FULFILLED` (+ `providerTransactionId`, + `meta` for electricity), on failure `FAILED` (+ `lastError`, increment `attempts`). Log every outbound call to `ProviderCallLog`.
3. `refund`/`dispute` webhooks → flag `Order.refunded` / `disputed`.

**Provider executors to port (frontend → backend), preserving logic verbatim:**
| Frontend file | Backend target |
|---|---|
| `src/lib/fulfillment/reloadly-topup.ts` | Reloadly topup executor |
| `src/lib/fulfillment/reloadly-gift-card.ts` | Reloadly gift-card executor |
| `src/lib/fulfillment/reloadly-pay-bill.ts` | Reloadly utility executor |
| `src/lib/fulfillment/planettalk-topup.ts` | buhibab topup executor |
| `src/lib/fulfillment/planettalk-pay-bill.ts` | buhibab utility executor |
| `src/lib/fulfillment/pricing.ts` | pricing service (uses static FX) |
| `src/lib/fulfillment/{metadata,signature,guard}.ts` | PI metadata + HMAC + idempotency guard |
| `src/lib/fulfillment/fulfill-payment-intent.ts` | fulfilment orchestrator |

**⚠️ CARRY THE buhibab CHANGE (already done in the frontend, commit `463aea5`):**
- Every buhibab purchase payload now **must include `email`** (buyer email). Without it purchases are rejected ("Action Required").
- The buhibab purchase **response returns `meta`** = `{ token, units, ... }` for **electricity** (null for airtime/data/cabletv). Capture it into `Fulfillment.meta`/`Order` and surface it (electricity token) on receipts.
- Reference the frontend `planettalk-topup.ts` / `planettalk-pay-bill.ts` for the exact FormData + `responseBody.data?.meta ?? responseBody.meta ?? null` handling.

**New backend endpoints (roughly):**
- `POST /api/payments/create-intent` (public, unauthenticated — clients stay unauthenticated)
- `POST /api/payments/webhook` (Stripe signature-verified; raw body)
- `GET  /api/payments/verify?paymentIntentId=…`
- Wire `admin-orders.service#retry()` → the same claim+execute path.

**Env the backend will then need (add to `~/deployments/topupapi/.env.production`; already present, see §6):** `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `FULFILLMENT_SIGNING_SECRET` — already populated (reused from the frontend). **New Stripe webhook endpoint** must be registered in the Stripe dashboard pointing at `https://topupapi.planettalk.com/api/payments/webhook` with a **new** signing secret (or reuse if same account/events) — decide during Phase 4.

**Testing constraints:**
- **buhibab has NO sandbox** — a completed NG purchase spends real balance. Do **not** run live end-to-end without explicit sign-off. Stripe is in test mode locally.
- Local dev is Docker-free: Windows-native Postgres `:5432`, WSL Redis (`redis-off` graceful fallback fine). Prisma 7 needs `prisma.config.ts` for CLI datasource url (see §6 gotcha).

---

## 5. PHASE 5 — cut the frontend over

Once Phase 4 is verified:
- Point the frontend's payment + fulfilment calls at the backend instead of its own `/api/*` routes (introduce `NEXT_PUBLIC_API_URL` usage in the checkout flow; the var is already wired through Docker/compose/Makefile).
- Optionally repoint catalog/currency/geo to the backend too (already built there).
- Delete/retire the now-dead frontend `/api/*` route handlers once nothing calls them.
- Keep the frontend's Stripe **publishable** key client-side; the **secret** key + webhook move fully server-side (backend).
- Deploy frontend via `develop → main` PR → `make deploy`.

---

## 6. Deploy mechanics & env (reference)

### TopupApi deploy (from a fresh push)
```bash
# 1. push (from WSL, neilBv key)
git -C /mnt/c/Projects/Backend/TopupApi -c safe.directory='*' \
  push git@github-neilbv:Planettalk-Limited/TopupApi.git <branch>:main
# 2. on droplet
ssh planettalk-devop 'cd ~/deployments/topupapi/application && git pull --ff-only && docker compose up -d --build app'
# migrations run automatically on boot (compose cmd: npx prisma migrate deploy && node dist/main.js)
```

### TopupApi Docker gotchas already fixed (commit `fb479bd`) — keep intact
- `prisma` **and** `dotenv` are **runtime dependencies** (needed by `prisma migrate deploy` + `prisma.config.ts` in the slim prod image).
- `prisma.config.ts` is **COPY**ed into the production image (Prisma 7 forbids `url` in `schema.prisma`; the datasource url lives in the config, which must ship in the image).
- Admin seed for prod is **plain JS** `prisma/seed-admin.js` (no ts-node). The TS `seed-admin.ts` is local-only.

### CORS (backend `src/main.ts`)
- `methods: ['GET','POST','PATCH','DELETE']`, `allowedHeaders: ['Content-Type','Authorization']`, origins from `CORS_ORIGIN`. Phase 4 adds no new methods; ensure the frontend origin stays allowlisted.

### TopupApi `.env.production` (on droplet, already populated — values NOT here)
Keys present: `NODE_ENV, PORT, CORS_ORIGIN, DATABASE_URL, POSTGRES_{DB,USER,PASSWORD}, REDIS_URL, RELOADLY_{SANDBOX,CLIENT_ID,CLIENT_SECRET,BALANCE_ALERT_THRESHOLD}, PLANETTALK_{API_URL,EMAIL,PASSWORD}, TOPUP_PROVIDER_NG, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, FULFILLMENT_SIGNING_SECRET, JWT_SECRET, JWT_EXPIRES_IN, ADMIN_API_TOKEN, ADMIN_SEED_{EMAIL,PASSWORD,NAME}, MAILGUN_{API_KEY,DOMAIN,API_URL,FROM_EMAIL}`. A separate `.env` holds `POSTGRES_*` for compose `${...}` substitution.
- Secrets were reused from `~/deployments/topup/application/.env.production` (Stripe/Reloadly/buhibab/fulfillment) and `~/deployments/api/application/.env.prod` (Mailgun); DB/JWT/admin secrets freshly generated. Regenerate helper: `~/deployments/topupapi/gen-env.sh`.

### Frontend new env (already added to droplet `~/deployments/topup/application/.env.production`)
- `NEXT_PUBLIC_API_URL=https://topupapi.planettalk.com`
- `NEXT_PUBLIC_CREDITBACK_API_URL=https://topupapi.planettalk.com`
- Both are `NEXT_PUBLIC_*` → baked at **build time**; wired through `Dockerfile` (ARG/ENV), `docker-compose.yml` (`build.args`), and `Makefile` (`--build-arg`, targets `deploy`/`rebuild`). `make deploy` sources `.env.production` and passes them.

---

## 7. Verification checklist for Phase 4 (before calling it done)
- [ ] `create-intent` computes price server-side (static FX) and rejects client-supplied prices; writes `Order(CREATED)`.
- [ ] Webhook verifies Stripe signature + HMAC; idempotent (replayed events don't double-fulfil).
- [ ] `Fulfillment` claimed with `SELECT … FOR UPDATE`; concurrent webhooks don't double-deliver.
- [ ] Every provider call logged to `ProviderCallLog`; admin Orders/Providers/Dashboard now show real data.
- [ ] buhibab payload includes `email`; electricity `meta` (token/units) captured + shown.
- [ ] Refund/dispute webhooks flag the order.
- [ ] Admin **retry** actually re-runs fulfilment (not the stub).
- [ ] Stripe webhook endpoint registered → `https://topupapi.planettalk.com/api/payments/webhook`.
- [ ] **No live buhibab purchase run without explicit user sign-off** (no sandbox).

---

## 8. Open loose ends (not blockers)
- Adminer service (`warehouse.planettalk.com`) — confirm it's up (`docker compose up -d adminer`) and basic-auth works (user `admin`).
- Frontend PR `develop → main` + `make deploy` still pending (creditback popup + admin console go live then).
- buhibab email/meta fix is live in the **frontend** executors; must be replicated in the **backend** port (Phase 4).
