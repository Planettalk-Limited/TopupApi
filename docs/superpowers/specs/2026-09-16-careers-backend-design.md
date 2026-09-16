# Careers backend — design spec

Status: decisions confirmed 2026-09-16. Third and final sub-project of the Astro→TopupApp
migration (see the master spec:
`../../../../Frontend/TopupApp/docs/superpowers/specs/2026-09-15-astro-migration-design.md`).
Foundation and Easy Pages (the other two sub-projects, both TopupApp-side) are merged. This spec
covers the backend half of Careers — the piece that needs a new repo, this one — not the
TopupApp-side UI, which gets its own plan once this is done.

## Why this lands here, not in TopupApp

The Astro site's careers feature (job postings, applications, CV storage, admin console) runs on
Netlify Blobs + Netlify Functions — infrastructure that doesn't exist in TopupApp's Docker/
Traefik world. The confirmed decision (see master spec) is to build real storage into TopupApi
rather than keep a third hosting platform in the mix long-term. TopupApi already has everything
else this needs: Postgres (via Prisma), JWT admin auth with role-based guards, a working Mailgun
integration, and cron infrastructure (`@nestjs/schedule`) — surveyed in full on 2026-09-16.

## What does NOT change

Every product behavior documented in the Astro implementation (`docs/CAREERS.md` in the
`planettalk-web-app` repo) is preserved:
- Job posting statuses: `open` / `closed`. A closed role's page still exists (not a 404) — the
  frontend plan (not this one) owns that distinction; this backend just reports the true status.
- Application statuses: `new` → `shortlisted` / `rejected` / `hired`. Sending a rejection email
  is a distinct, non-idempotent action from setting status (only fires once — matches Astro's
  `rejectionSentAt` dedup guard).
- Closed-vocabulary fields, exact values (confirmed from `netlify/functions/careers-apply.mjs`):
  - `yearsExperience`: `Less than 1 year`, `1–2 years`, `3–5 years`, `6–9 years`, `10+ years`
  - `workPreference`: `Remote`, `Hybrid`, `On-site`
  - `rightToWork`: `Yes`, `No`, `Need sponsorship`
- CV constraints: PDF/DOC/DOCX only, 5MB max, filename never trusted (server-generates the
  storage key).
- 365-day retention purge, weekly.
- Deleting a job posting does NOT delete its applications (deliberate, per Astro's
  `docs/CAREERS.md`).
- `cleanUrl()`-style sanitization on `linkedin`/`portfolio` (only `http:`/`https:` survive).

## What does change (and why)

| Astro/Netlify | TopupApi |
|---|---|
| Netlify Blobs (`careers-jobs`, `careers-applications`, `careers-cvs` stores) | Postgres (`JobPosting`, `JobApplication` tables) + DigitalOcean Spaces (CV binary storage) |
| Netlify Functions, one file per concern | NestJS module `src/careers/`, following the existing `admin/*` controller+service+DTO pattern |
| HMAC-signed session cookie, single shared admin password | Existing `JwtAuthGuard` + `RolesGuard` — reuses the real admin accounts already in `AdminUser`, not a separate careers-only login. This is a genuine improvement: per-admin identity and an audit trail, which the Astro implementation explicitly named as its biggest gap ("not a user system... rotate the password manually when someone leaves"). |
| Raw HTTP Mailgun calls, isolated `careers-email.mjs` | A new `CareersEmailService`, same isolation principle (own file, own `FROM` address), but built on the `mailgun.js` client already wired in this repo — no new email dependency. |
| Scheduled Netlify Function (`careers-purge.mjs`, weekly) | `@Cron(CronExpression.EVERY_WEEK)` service, same pattern as `src/payments/reconciliation.service.ts`. |

**Storage decision: DigitalOcean Spaces (S3-compatible), not local disk.** TopupApi's containers
have no persistent-volume convention beyond the Postgres/Redis data volumes — CVs on local disk
would be lost on every redeploy. Spaces is S3-API-compatible (`@aws-sdk/client-s3`, one new
dependency), fits the existing DigitalOcean droplet hosting, and mirrors how the Astro
implementation already kept CV bytes in a separate store from application metadata.

**Auth decision: reuse `AdminUser` + `JwtAuthGuard`, not a new careers-only login.** The Astro
console's single-shared-password model was a known, accepted limitation there ("not a user
system"). Since this backend already has real per-admin accounts with roles, careers admin
endpoints just need `@UseGuards(JwtAuthGuard)` like every other admin controller — no new auth
surface, and audit logging (`AdminAuditLog`) comes for free.

## Data model (see plan Task 1 for the actual Prisma schema)

- `JobPosting`: title, department, location (free text — Astro's `location` field was
  keyword-matched to a country/flag for display; that matching logic is a frontend concern, not
  stored here), employment type, description, status, slug, timestamps, `createdByAdminId`.
- `JobApplication`: FK to `JobPosting`, applicant fields, the three closed-vocabulary fields
  (stored as plain `String`, validated by DTO `@IsIn`, not Postgres enums — their values contain
  characters like `–` and `+` that don't map cleanly to Postgres enum identifiers), CV metadata
  (storage key, original filename, content type, size — never the bytes themselves), status,
  `rejectionSentAt`, timestamps.

## Sequencing within this plan

Schema → storage service → email service → public read endpoints → public apply endpoint →
admin job postings CRUD → admin applications management → retention cron. Public apply depends
on storage + email; admin applications depends on storage (CV download) + email (rejection).

## Explicitly out of scope for this plan

- The TopupApp-side UI (public `/careers` listing, `/careers/[slug]` detail pages, admin console
  screens) — a separate frontend plan, written after this backend exists, since the frontend
  needs a real API to call.
- The `mailto:`-based general-application flow (Astro's own documented, accepted gap) — not
  being fixed as part of this migration; flag it again if speculative-application volume ever
  becomes a real ask.
- Swagger/OpenAPI docs — this repo has no existing convention for it (hand-written README
  prose); new endpoints get the same treatment, not a new documentation system introduced
  unilaterally.
