import { BadRequestException, NotFoundException } from '@nestjs/common'
import { BeneficiariesService, MAX_BENEFICIARIES } from './beneficiaries.service'
import { createFakeCustomerPrisma, FakeCustomerPrisma } from './testing/fake-customer-prisma'

const CUSTOMER = 'cust-1'

describe('BeneficiariesService', () => {
  let prisma: FakeCustomerPrisma
  let service: BeneficiariesService

  beforeEach(() => {
    prisma = createFakeCustomerPrisma()
    service = new BeneficiariesService(prisma as any)
  })

  it('creates a phone beneficiary, normalised to E.164, and lists it without the customerId', async () => {
    const created = await service.create(CUSTOMER, {
      kind: 'PHONE',
      label: ' Mum ',
      countryCode: 'ng',
      phone: '0803 123 4567',
    })

    expect(created).toMatchObject({ kind: 'PHONE', label: 'Mum', countryCode: 'NG', phone: '+2348031234567' })
    expect(created).not.toHaveProperty('customerId')
    expect(await service.list(CUSTOMER)).toEqual([created])
    expect(await service.list('someone-else')).toEqual([])
  })

  it('dedupes on kind + identifier and returns the existing entry', async () => {
    const first = await service.create(CUSTOMER, { kind: 'PHONE', label: 'Mum', countryCode: 'NG', phone: '08031234567' })
    const again = await service.create(CUSTOMER, { kind: 'PHONE', label: 'Mother', countryCode: 'NG', phone: '+234 803 123 4567' })

    expect(again.id).toBe(first.id)
    expect(prisma.beneficiary.rows).toHaveLength(1)
  })

  it('dedupes meters on biller + meter number, and emails case-insensitively', async () => {
    const m1 = await service.create(CUSTOMER, { kind: 'METER', label: 'Home', meterNumber: '0422 3568', billerId: 994 })
    const m2 = await service.create(CUSTOMER, { kind: 'METER', label: 'Home 2', meterNumber: '04223568', billerId: 994 })
    const m3 = await service.create(CUSTOMER, { kind: 'METER', label: 'Shop', meterNumber: '04223568', billerId: 995 })
    expect(m2.id).toBe(m1.id)
    expect(m3.id).not.toBe(m1.id)

    const e1 = await service.create(CUSTOMER, { kind: 'EMAIL', label: 'Bro', email: 'Bro@Example.com' })
    const e2 = await service.create(CUSTOMER, { kind: 'EMAIL', label: 'Bro', email: 'bro@example.com ' })
    expect(e2.id).toBe(e1.id)
  })

  it('requires the identifier that matches the kind', async () => {
    await expect(service.create(CUSTOMER, { kind: 'PHONE', label: 'x', countryCode: 'NG' })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(
      service.create(CUSTOMER, { kind: 'PHONE', label: 'x', countryCode: 'NG', phone: '123' }),
    ).rejects.toBeInstanceOf(BadRequestException)
    await expect(service.create(CUSTOMER, { kind: 'METER', label: 'x', meterNumber: '1' })).rejects.toBeInstanceOf(
      BadRequestException,
    )
    await expect(service.create(CUSTOMER, { kind: 'EMAIL', label: 'x' })).rejects.toBeInstanceOf(BadRequestException)
  })

  it(`caps a customer at ${MAX_BENEFICIARIES}`, async () => {
    for (let i = 0; i < MAX_BENEFICIARIES; i++) {
      await service.create(CUSTOMER, { kind: 'EMAIL', label: `p${i}`, email: `p${i}@example.com` })
    }
    const error = await service
      .create(CUSTOMER, { kind: 'EMAIL', label: 'one too many', email: 'x@example.com' })
      .catch((e) => e)
    expect(error).toBeInstanceOf(BadRequestException)
    expect(error.getResponse().code).toBe('BENEFICIARY_LIMIT')
  })

  it('deletes only the caller’s own beneficiary', async () => {
    const mine = await service.create(CUSTOMER, { kind: 'EMAIL', label: 'Bro', email: 'bro@example.com' })

    await expect(service.remove('someone-else', mine.id)).rejects.toBeInstanceOf(NotFoundException)
    await expect(service.remove(CUSTOMER, mine.id)).resolves.toEqual({ ok: true })
    expect(prisma.beneficiary.rows).toHaveLength(0)
  })
})
