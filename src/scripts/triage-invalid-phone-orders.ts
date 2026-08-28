/**
 * Triage the orders stranded by the Reloadly INVALID_RECIPIENT_PHONE incident.
 *
 * The top-up executor used to strip the dialling code off the recipient phone with a
 * length heuristic; Reloadly re-prefixed the country code and rejected a number that did
 * not exist, so customers were charged and never fulfilled. See src/common/phone.ts.
 *
 * This script is STRICTLY READ-ONLY. It runs every FAILED fulfilment through the same
 * classifier the fix uses and tells you which orders need which action. It never calls
 * Stripe, never calls a provider, and never writes to the database.
 *
 * Lives under src/ (not prisma/) on purpose: the production image is built with
 * `npm ci --omit=dev` and ships only dist/, so it has no ts-node. Compiling with the app
 * means it can be run in prod with plain node.
 *
 * Usage in production (inside the running app container):
 *   docker compose exec app node dist/scripts/triage-invalid-phone-orders.js
 *   docker compose exec app node dist/scripts/triage-invalid-phone-orders.js --days 30
 *
 * Usage locally, from the TopupApi root with DATABASE_URL set:
 *   npx ts-node src/scripts/triage-invalid-phone-orders.ts --csv triage.csv
 *
 * NOTE: output includes recipient phone numbers (that is the point — you need to eyeball
 * them), so treat the console output and any CSV as customer PII.
 */
import 'dotenv/config'
import * as fs from 'fs'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { Pool } from 'pg'
import { classifyFailedFulfillment, type TriageBucket } from '../payments/incident-triage'

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const BUCKET_ORDER: TriageBucket[] = ['NEEDS_RETRY', 'NEEDS_REFUND', 'SELF_HEALS', 'UNRELATED']

const HEADLINE: Record<TriageBucket, string> = {
  NEEDS_RETRY:
    'ACTION: admin retry. Deliverable number, but automatic attempts are exhausted.',
  NEEDS_REFUND:
    'ACTION: refund. The number cannot be delivered to — no retry will ever succeed.',
  SELF_HEALS:
    'NO ACTION. The reconciliation worker will retry these itself once the fix is deployed.',
  UNRELATED:
    'INSPECT BY HAND. Not this incident — a replay could double-deliver, so it is excluded.',
}

async function main() {
  const days = Number(arg('days', '30'))
  const csvPath = arg('csv', '')

  if (!Number.isFinite(days) || days <= 0) {
    throw new Error('--days must be a positive number')
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL })
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) })

  try {
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000)

    const rows = await prisma.fulfillment.findMany({
      where: { status: 'FAILED', order: { createdAt: { gte: since } } },
      include: { order: true },
      orderBy: { updatedAt: 'desc' },
    })

    console.log(`\nFAILED fulfilments in the last ${days} day(s): ${rows.length}`)
    console.log(`DATABASE_URL host: ${new URL(process.env.DATABASE_URL ?? 'postgres://?').hostname}\n`)

    const triaged = rows.map((f) => {
      const verdict = classifyFailedFulfillment({
        productType: f.order.productType,
        countryCode: f.order.countryCode,
        recipientPhone: f.order.recipientPhone,
        lastError: f.lastError,
        attempts: f.attempts,
      })
      return { f, verdict }
    })

    for (const bucket of BUCKET_ORDER) {
      const group = triaged.filter((t) => t.verdict.bucket === bucket)
      if (group.length === 0) continue

      console.log(`${'='.repeat(78)}\n${bucket}  (${group.length})\n${HEADLINE[bucket]}\n`)

      // Money still held per currency — what you would be refunding in the worst case.
      const byCurrency = new Map<string, number>()
      for (const { f } of group) {
        const cur = f.order.chargeCurrency.toUpperCase()
        byCurrency.set(cur, (byCurrency.get(cur) ?? 0) + Number(f.order.chargeAmount))
      }
      const money = [...byCurrency].map(([c, a]) => `${a.toFixed(2)} ${c}`).join(', ')
      console.log(`  charged and held: ${money}\n`)

      for (const { f, verdict } of group) {
        console.log(`  ${f.order.paymentIntentId}`)
        console.log(
          `    ${f.order.countryCode} ${f.order.productType}  ` +
            `${Number(f.order.chargeAmount).toFixed(2)} ${f.order.chargeCurrency.toUpperCase()}  ` +
            `attempts=${f.attempts}  refunded=${f.order.refunded}`
        )
        console.log(`    stored phone: ${f.order.recipientPhone ?? '(none)'}`)
        if (verdict.wouldSend) console.log(`    would now send: ${verdict.wouldSend}`)
        console.log(`    lastError: ${f.lastError ?? '(none)'}`)
        console.log(`    -> ${verdict.reason}\n`)
      }
    }

    const retry = triaged.filter((t) => t.verdict.bucket === 'NEEDS_RETRY')
    const refund = triaged.filter((t) => t.verdict.bucket === 'NEEDS_REFUND' && !t.f.order.refunded)

    console.log(`${'='.repeat(78)}\nNEXT STEPS\n`)
    if (retry.length === 0 && refund.length === 0) {
      console.log('  Nothing needs a manual action.\n')
    }
    if (retry.length > 0) {
      console.log(`  Retry (${retry.length}) — POST /admin/orders/:paymentIntentId/retry`)
      for (const { f } of retry) console.log(`    ${f.order.paymentIntentId}`)
      console.log('')
    }
    if (refund.length > 0) {
      console.log(`  Refund (${refund.length}) — POST /admin/orders/:paymentIntentId/refund  [SUPERADMIN]`)
      for (const { f } of refund) console.log(`    ${f.order.paymentIntentId}`)
      console.log('')
    }
    console.log(
      '  A retry re-prices the order from scratch (assertPaidEnough). If the price or FX\n' +
        '  has moved up since the charge, the retry returns 402 "Amount paid does not cover\n' +
        '  this order" — refund those rather than forcing them through.\n'
    )

    if (csvPath) {
      const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
      const csv = [
        'bucket,paymentIntentId,countryCode,productType,chargeAmount,chargeCurrency,attempts,refunded,storedPhone,wouldSend,lastError,reason',
        ...triaged.map(({ f, verdict }) =>
          [
            verdict.bucket, f.order.paymentIntentId, f.order.countryCode, f.order.productType,
            Number(f.order.chargeAmount).toFixed(2), f.order.chargeCurrency, f.attempts,
            f.order.refunded, f.order.recipientPhone, verdict.wouldSend, f.lastError, verdict.reason,
          ].map(esc).join(',')
        ),
      ].join('\n')
      fs.writeFileSync(csvPath, csv, 'utf8')
      console.log(`  CSV written to ${csvPath} (contains customer phone numbers)\n`)
    }
  } finally {
    await prisma.$disconnect()
    await pool.end()
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
