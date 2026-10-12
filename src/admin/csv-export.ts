import { BadRequestException } from '@nestjs/common'
import { PrismaService } from '../common/prisma.service'
import { AuthenticatedAdmin } from '../auth/jwt-payload.interface'

/**
 * Shared plumbing for the console's CSV exports. Every export:
 *  - follows the same filters as the page it is downloaded from,
 *  - lists its columns explicitly (so secrets — password hashes, gift-card codes,
 *    CV storage keys, healthcare details — can only appear if someone adds them here),
 *  - is capped at EXPORT_ROW_LIMIT rows, and
 *  - writes an audit row, since most of them are bulk personal data.
 */
export const EXPORT_ROW_LIMIT = 50_000

/** Query `take` for an export: one over the cap, so `capRows` can tell "exactly the cap" from "more". */
export const EXPORT_TAKE = EXPORT_ROW_LIMIT + 1

export type CsvColumn<T> = readonly [header: string, value: (row: T) => unknown]

/** RFC 4180 cell, with a leading quote on formula-looking values so Excel won't execute them. */
export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return ''
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join('|') : String(value)
  // E.164 phones (+ then digits only) and plain negative numbers can't carry a formula, so they stay readable.
  if (/^[=+\-@\t\r]/.test(text) && !/^\+\d+$/.test(text) && !/^-\d+(\.\d+)?$/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/** UTF-8 BOM first so Excel reads accented names correctly; CRLF line endings per RFC 4180. */
export function toCsv<T>(columns: readonly CsvColumn<T>[], rows: readonly T[]): string {
  const lines = [columns.map(([header]) => csvCell(header)).join(',')]
  for (const row of rows) lines.push(columns.map(([, value]) => csvCell(value(row))).join(','))
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** Refuses an export that would exceed the cap rather than silently truncating it. */
export function capRows<T>(rows: T[]): T[] {
  if (rows.length > EXPORT_ROW_LIMIT) {
    throw new BadRequestException(
      `This export has more than ${EXPORT_ROW_LIMIT.toLocaleString('en-GB')} rows — narrow the filters and try again.`,
    )
  }
  return rows
}

/** Best-effort audit row for an export, as elsewhere in the console. */
export async function auditExport(
  prisma: PrismaService,
  admin: AuthenticatedAdmin,
  action: string,
  rowCount: number,
  filters: object = {},
): Promise<void> {
  const applied = Object.entries(filters).filter(([, v]) => v !== undefined && v !== null && v !== '')
  const result = `${rowCount} rows${applied.length ? ` · ${applied.map(([k, v]) => `${k}=${v}`).join(' ')}` : ''}`
  try {
    await prisma.adminAuditLog.create({
      data: { adminId: admin.id, action, target: null, result: result.slice(0, 500) },
    })
  } catch {
    // swallow — audit logging is best-effort, not the source of truth
  }
}
