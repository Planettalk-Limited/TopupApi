# Payments engine — local integration runbook (SP-2)

The payment/fulfilment engine (`src/payments/`) for the **Reloadly-topup** slice.
This runbook shows how to exercise it locally end-to-end. Everything here is
**test-mode / sandbox only** — no live money.

## What's already verified (no credentials needed)

- `npm test` — unit suite green (pricing static-FX math, HMAC signature round-trip
  + tamper reject, metadata build/parse, executor idempotency key + retryable
  classification, orchestrator claim/idempotency/concurrency + no-PENDING-revert,
  webhook dispatch + signature + refund/dispute).
- `npm run build` — compiles.
- Boot + module wiring: `node dist/main.js` then
  - `GET /api/payments/verify?paymentIntentId=pi_missing` → `404 {"error":"Order not found"}`
  - `POST /api/payments/create-intent` with no `STRIPE_SECRET_KEY` → `503`

## Prerequisites for the full E2E (you supply)

1. Local Postgres running (`:5432`) with migrations applied: `npx prisma migrate deploy`.
2. `.env` in `C:\Projects\Backend\TopupApi` with:
   ```
   DATABASE_URL=postgresql://.../topupApiDB      # local
   RELOADLY_SANDBOX=true
   RELOADLY_CLIENT_ID=<sandbox client id>
   RELOADLY_CLIENT_SECRET=<sandbox client secret>
   STRIPE_SECRET_KEY=sk_test_...                 # Stripe TEST mode
   STRIPE_WEBHOOK_SECRET=whsec_...               # from `stripe listen`, step 3
   FULFILLMENT_SIGNING_SECRET=<any dev value>
   ```
   (The frontend `TopupApp/.env.local` already has Reloadly sandbox creds you can reuse.)
3. [Stripe CLI](https://stripe.com/docs/stripe-cli) installed + `stripe login` (test mode).

## Steps

### 1. Start the API
```bash
npx prisma migrate deploy
npm run start:dev        # listens on :3001
```

### 2. Forward Stripe webhooks to the local API
```bash
stripe listen --forward-to localhost:3001/api/payments/webhook
```
Copy the printed `whsec_...` into `.env` as `STRIPE_WEBHOOK_SECRET`, then restart the API.

### 3. Create an intent (server prices it authoritatively)
Pick a real sandbox operator + a valid denomination for GB (query
`GET /api/reloadly/operators?countryCode=GB` for `operatorId`/limits):
```bash
curl -s -X POST localhost:3001/api/payments/create-intent \
  -H 'Content-Type: application/json' \
  -d '{"currency":"gbp","order":{"productType":"topup","countryCode":"GB",
       "operatorId":<operatorId>,"recipientPhone":"+447700900000",
       "providerAmount":<validAmount>,"providerCurrency":"GBP","useLocalAmount":false}}'
```
Expect `{clientSecret, paymentIntentId, amount, currency}`. Confirm in the DB a new
`orders` row (status `CREATED`) + `fulfillments` row (status `PENDING`):
```bash
# psql: SELECT status FROM orders WHERE "paymentIntentId"='<pi>';
#       SELECT status FROM fulfillments f JOIN orders o ON f."orderId"=o.id WHERE o."paymentIntentId"='<pi>';
```

### 4. Drive the PaymentIntent to `succeeded`
Confirm the specific intent with a test card (so our metadata is preserved):
```bash
stripe payment_intents confirm <paymentIntentId> --payment-method pm_card_visa
```
(Do NOT use `stripe trigger payment_intent.succeeded` — it creates a throwaway intent
without our `source`/order metadata, which the webhook correctly skips.)

The `stripe listen` window shows `payment_intent.succeeded` forwarded → the webhook
fulfils it. Expect:
- `orders.status` → `FULFILLED`, `fulfillments.status` → `FULFILLED` +
  `providerTransactionId` set + `fulfilledAt`.
- a `provider_call_logs` row (`provider=RELOADLY`, `endpoint=/topups`, `success=true`).
- `GET /api/payments/verify?paymentIntentId=<pi>` → `{orderStatus:'FULFILLED',
  fulfillmentStatus:'FULFILLED', providerTransactionId:'…'}`.

### 5. Idempotency (replay)
```bash
stripe events resend <evt_id_of_the_succeeded_event>
```
Expect NO second Reloadly call and status stays `FULFILLED` (the claim sees a
non-`PENDING` row and no-ops).

### 6. Concurrency
Resend the succeeded event twice in quick succession (two terminals). Expect exactly
one `provider_call_logs` success row and one `FULFILLED` — the `SELECT … FOR UPDATE`
claim serialises the deliveries.

### 7. Failure path (optional)
Use an operator/amount Reloadly sandbox rejects, or temporarily point at a bad
operator id. Expect `fulfillments.status=FAILED` + `lastError` set + `attempts=1` +
a failure `provider_call_logs` row, and the webhook returns 500 (retryable) so Stripe
redelivers.

## Guardrails
- **buhibab/PlanetTalk is NOT in this slice** and has **no sandbox** — do not run any
  NG/PlanetTalk purchase. That executor + a live E2E come later with explicit sign-off.
- Keep `RELOADLY_SANDBOX=true` and Stripe in **test mode** throughout.

## SP-3 (later, not here)
Point the frontend checkout at these endpoints, register the **production** Stripe
webhook at `https://topupapi.planettalk.com/api/payments/webhook`, rotate all secrets,
and retire the frontend `/api/stripe/*` + `/api/fulfill` routes.
