import { NotFoundException } from '@nestjs/common'
import { GUARDS_METADATA } from '@nestjs/common/constants'
import { HealthcareQuoteController } from '../payments/healthcare-quote.controller'
import { HealthcareCatalogController } from '../providers/buhibab/healthcare-catalog.controller'
import { HealthcareEnabledGuard, isHealthcareEnabled } from './healthcare-enabled'

describe('healthcare feature switch', () => {
  afterEach(() => {
    delete process.env.HEALTHCARE_ENABLED
  })

  it('is off by default and for anything but "true"', () => {
    expect(isHealthcareEnabled()).toBe(false)
    for (const v of ['false', '1', 'TRUE', '']) {
      process.env.HEALTHCARE_ENABLED = v
      expect(isHealthcareEnabled()).toBe(false)
    }
  })

  it('guard 404s healthcare routes while off', () => {
    expect(() => new HealthcareEnabledGuard().canActivate()).toThrow(NotFoundException)
  })

  it('guard lets requests through when HEALTHCARE_ENABLED=true', () => {
    process.env.HEALTHCARE_ENABLED = 'true'
    expect(new HealthcareEnabledGuard().canActivate()).toBe(true)
  })

  it.each([
    ['HealthcareQuoteController', HealthcareQuoteController],
    ['HealthcareCatalogController', HealthcareCatalogController],
  ])('%s is behind the guard', (_name, controller) => {
    expect(Reflect.getMetadata(GUARDS_METADATA, controller)).toContain(HealthcareEnabledGuard)
  })
})
