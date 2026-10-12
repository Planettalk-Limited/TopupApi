import { BadRequestException } from '@nestjs/common'
import { auditExport, capRows, csvCell, EXPORT_ROW_LIMIT, toCsv } from './csv-export'

describe('csv-export', () => {
  it('csvCell neutralises formulas but keeps phones and negative numbers readable', () => {
    expect(csvCell('+447700900000')).toBe('+447700900000')
    expect(csvCell('-12.50')).toBe('-12.50')
    expect(csvCell('+SUM(A1)')).toBe("'+SUM(A1)")
    expect(csvCell('-2+3')).toBe("'-2+3")
    expect(csvCell('@cmd')).toBe("'@cmd")
    expect(csvCell('a,b')).toBe('"a,b"')
    expect(csvCell(['topup', 'data'])).toBe('topup|data')
    expect(csvCell(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(csvCell(null)).toBe('')
  })

  it('toCsv writes a BOM, a header row and CRLF lines', () => {
    const csv = toCsv([['name', (r: { n: string }) => r.n]], [{ n: 'Zoë' }, { n: 'x"y' }])
    expect(csv).toBe('﻿name\r\nZoë\r\n"x""y"\r\n')
  })

  it('capRows refuses an export over the limit instead of truncating it', () => {
    expect(capRows(new Array(EXPORT_ROW_LIMIT).fill(0))).toHaveLength(EXPORT_ROW_LIMIT)
    expect(() => capRows(new Array(EXPORT_ROW_LIMIT + 1).fill(0))).toThrow(BadRequestException)
  })

  it('auditExport records the row count and only the filters that were set', async () => {
    const prisma = { adminAuditLog: { create: jest.fn().mockResolvedValue({}) } }
    await auditExport(prisma as any, { id: 'a1' } as any, 'export_orders', 3, { status: 'FAILED', search: '', to: undefined })
    expect(prisma.adminAuditLog.create).toHaveBeenCalledWith({
      data: { adminId: 'a1', action: 'export_orders', target: null, result: '3 rows · status=FAILED' },
    })
  })

  it('auditExport never fails the export when the audit write fails', async () => {
    const prisma = { adminAuditLog: { create: jest.fn().mockRejectedValue(new Error('db down')) } }
    await expect(auditExport(prisma as any, { id: 'a1' } as any, 'export_orders', 0)).resolves.toBeUndefined()
  })
})
