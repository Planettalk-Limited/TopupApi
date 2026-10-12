// Minimal in-memory stand-in for the slice of PrismaClient the customer-account code
// uses (customers, customer tokens, beneficiaries). Test-only: lets the auth flows run
// end to end (register -> verify -> login -> reset) without a database, while still
// enforcing the unique constraints the real schema has.
import { randomUUID } from 'crypto'

type Row = Record<string, any>

function matches(row: Row, where: Row = {}): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('gt' in cond) return row[key] > cond.gt
      if ('in' in cond) return cond.in.includes(row[key])
      if ('not' in cond) return row[key] !== cond.not
    }
    if (cond === null) return row[key] === null || row[key] === undefined
    return row[key] === cond
  })
}

function uniqueViolation(target: string) {
  return Object.assign(new Error(`Unique constraint failed on ${target}`), {
    code: 'P2002',
    meta: { target: [target] },
  })
}

class Table {
  rows: Row[] = []
  constructor(private readonly uniques: string[] = [], private readonly defaults: () => Row = () => ({})) {}

  private checkUnique(candidate: Row, selfId?: string) {
    for (const key of this.uniques) {
      if (candidate[key] === undefined || candidate[key] === null) continue
      if (this.rows.some((r) => r.id !== selfId && r[key] === candidate[key])) throw uniqueViolation(key)
    }
  }

  findUnique = jest.fn(async ({ where }: { where: Row }) => this.rows.find((r) => matches(r, where)) ?? null)
  findFirst = jest.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
    let found = this.rows.filter((r) => matches(r, where))
    if (orderBy?.createdAt === 'desc') found = [...found].reverse()
    return found[0] ?? null
  })
  findMany = jest.fn(async ({ where, orderBy }: { where?: Row; orderBy?: Row } = {}) => {
    const found = this.rows.filter((r) => matches(r, where))
    return orderBy?.createdAt === 'desc' ? [...found].reverse() : found
  })
  count = jest.fn(async ({ where }: { where?: Row } = {}) => this.rows.filter((r) => matches(r, where)).length)
  create = jest.fn(async ({ data }: { data: Row }) => {
    const row = { id: randomUUID(), createdAt: new Date(), ...this.defaults(), ...data }
    this.checkUnique(row)
    this.rows.push(row)
    return row
  })
  update = jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const row = this.rows.find((r) => matches(r, where))
    if (!row) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
    const next = { ...row }
    for (const [key, value] of Object.entries(data)) {
      next[key] = value && typeof value === 'object' && 'increment' in value ? (row[key] ?? 0) + value.increment : value
    }
    this.checkUnique(next, row.id)
    Object.assign(row, next)
    return row
  })
  updateMany = jest.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const found = this.rows.filter((r) => matches(r, where))
    found.forEach((r) => Object.assign(r, data))
    return { count: found.length }
  })
  delete = jest.fn(async ({ where }: { where: Row }) => {
    const idx = this.rows.findIndex((r) => matches(r, where))
    if (idx < 0) throw Object.assign(new Error('Record not found'), { code: 'P2025' })
    return this.rows.splice(idx, 1)[0]
  })
  deleteMany = jest.fn(async ({ where }: { where?: Row } = {}) => {
    const before = this.rows.length
    this.rows = this.rows.filter((r) => !matches(r, where))
    return { count: before - this.rows.length }
  })
}

export function createFakeCustomerPrisma() {
  const prisma = {
    customer: new Table(['email', 'phone'], () => ({ emailVerifiedAt: null, lastLoginAt: null })),
    customerToken: new Table([], () => ({ usedAt: null, attempts: 0 })),
    beneficiary: new Table(),
    $transaction: jest.fn(async (arg: unknown): Promise<unknown> => {
      if (typeof arg === 'function') return (arg as (tx: unknown) => unknown)(prisma)
      return Promise.all(arg as Promise<unknown>[])
    }),
  }
  return prisma
}

export type FakeCustomerPrisma = ReturnType<typeof createFakeCustomerPrisma>
