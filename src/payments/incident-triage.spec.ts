import { classifyFailedFulfillment, PHONE_INCIDENT_SIGNATURE } from './incident-triage'
import { MAX_ATTEMPTS } from './reconciliation.service'

const row = {
  productType: 'topup',
  countryCode: 'GB',
  recipientPhone: '+447860980321',
  lastError: 'Recipient phone number is not valid',
  attempts: MAX_ATTEMPTS,
}

describe('classifyFailedFulfillment', () => {
  it('sends a still-deliverable number that has exhausted its attempts to admin retry', () => {
    expect(classifyFailedFulfillment(row).bucket).toBe('NEEDS_RETRY')
  })

  it('leaves a still-deliverable number with attempts left to the reconciliation worker', () => {
    expect(classifyFailedFulfillment({ ...row, attempts: MAX_ATTEMPTS - 1 }).bucket).toBe('SELF_HEALS')
  })

  it('sends an undeliverable number to refund regardless of attempts', () => {
    expect(classifyFailedFulfillment({ ...row, recipientPhone: '12345' }).bucket).toBe('NEEDS_REFUND')
    expect(classifyFailedFulfillment({ ...row, recipientPhone: '12345', attempts: 1 }).bucket).toBe('NEEDS_REFUND')
  })

  it('treats a number valid only for a different country as undeliverable', () => {
    expect(classifyFailedFulfillment({ ...row, countryCode: 'NG' }).bucket).toBe('NEEDS_REFUND')
  })

  it('sends a reserved fictional range to refund, not retry', () => {
    // 07700 900xxx is Ofcom drama-range: it will fail forever, so retrying wastes attempts.
    expect(classifyFailedFulfillment({ ...row, recipientPhone: '+447700900000' }).bucket).toBe('NEEDS_REFUND')
  })

  // The safety rule that matters most. A 400 INVALID_RECIPIENT_PHONE proves Reloadly
  // created nothing, so replaying it cannot double-deliver. Any OTHER failure (timeout,
  // connection reset, 5xx) may have moved value at the provider without us recording it,
  // so it must never be swept into a bulk retry.
  it('refuses to classify a failure that is not the phone incident', () => {
    expect(classifyFailedFulfillment({ ...row, lastError: 'ECONNRESET' }).bucket).toBe('UNRELATED')
    expect(classifyFailedFulfillment({ ...row, lastError: 'Failed to process top-up' }).bucket).toBe('UNRELATED')
    expect(classifyFailedFulfillment({ ...row, lastError: null }).bucket).toBe('UNRELATED')
  })

  it('recognises both the provider wording and our own executor wording', () => {
    expect(PHONE_INCIDENT_SIGNATURE.test('Recipient phone number is not valid')).toBe(true)
    expect(PHONE_INCIDENT_SIGNATURE.test('Recipient phone number is not valid for this country')).toBe(true)
    expect(PHONE_INCIDENT_SIGNATURE.test('INVALID_RECIPIENT_PHONE')).toBe(true)
    expect(PHONE_INCIDENT_SIGNATURE.test('Operator currently unavailable')).toBe(false)
  })

  it('only applies to phone-bearing product types', () => {
    expect(classifyFailedFulfillment({ ...row, productType: 'giftcard', recipientPhone: null }).bucket).toBe('UNRELATED')
    expect(classifyFailedFulfillment({ ...row, productType: 'utility', recipientPhone: null }).bucket).toBe('UNRELATED')
  })

  it('reports the number it would send on retry, so the operator can eyeball it', () => {
    expect(classifyFailedFulfillment(row).wouldSend).toBe('447860980321')
    expect(classifyFailedFulfillment({ ...row, recipientPhone: '12345' }).wouldSend).toBeNull()
  })

  // Prisma returns ProductType as the uppercase DB enum (TOPUP/DATA), while the
  // fulfilment order types use lowercase. A mismatch here would silently bucket every
  // affected order as UNRELATED and the remediation run would find nothing.
  it('accepts the uppercase product type Prisma returns', () => {
    expect(classifyFailedFulfillment({ ...row, productType: 'TOPUP' }).bucket).toBe('NEEDS_RETRY')
    expect(classifyFailedFulfillment({ ...row, productType: 'DATA' }).bucket).toBe('NEEDS_RETRY')
    expect(classifyFailedFulfillment({ ...row, productType: 'GIFTCARD' }).bucket).toBe('UNRELATED')
  })

  it('accepts a lowercase country code from either source', () => {
    expect(classifyFailedFulfillment({ ...row, countryCode: 'gb' }).bucket).toBe('NEEDS_RETRY')
  })

  it('applies to data orders as well as topup', () => {
    expect(classifyFailedFulfillment({ ...row, productType: 'data' }).bucket).toBe('NEEDS_RETRY')
  })
})
