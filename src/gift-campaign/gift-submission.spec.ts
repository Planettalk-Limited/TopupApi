import { computeFlags, isE164, normaliseNigerianPhone, validateSubmission, type NormalisedSubmission } from './gift-submission'

const valid = {
  senderName: '  Ada   Obi ',
  senderEmail: 'Ada@Example.com',
  senderPhone: '+447400123456',
  recipientName: 'Chinedu Obi',
  recipientPhone: '+234 803 123 4567',
  relationship: 'parent',
  preferredContact: 'whatsapp',
  declarationAccepted: true,
  termsAccepted: true,
  termsVersion: 'v1',
}

describe('validateSubmission', () => {
  it('normalises a valid submission', () => {
    const r = validateSubmission(valid)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toMatchObject({
      senderName: 'Ada Obi',
      senderEmail: 'ada@example.com',
      recipientPhone: '+2348031234567',
      recipientEmail: null,
    })
  })

  it.each([
    ['sender phone not E.164', { senderPhone: '07700900123' }, /international format/],
    ['sender phone not a real number', { senderPhone: '+44123' }, /international format/],
    ['bad sender email', { senderEmail: 'ada@' }, /valid email/],
    ['non-Nigerian recipient', { recipientPhone: '+447700900456' }, /\+234/],
    ['national-format recipient', { recipientPhone: '08031234567' }, /\+234/],
    ['11-digit Nigerian recipient', { recipientPhone: '+23480312345678' }, /\+234/],
    ['bad recipient email', { recipientEmail: 'nope' }, /recipient's email/],
    ['missing declaration', { declarationAccepted: false }, /permission/],
    ['declaration as a string', { declarationAccepted: 'true' }, /permission/],
    ['missing terms', { termsAccepted: undefined }, /terms/],
    ['unknown relationship', { relationship: 'boss' }, /relationship/],
    ['email contact without email', { preferredContact: 'email' }, /recipient email/],
    ['missing recipient name', { recipientName: ' ' }, /recipient's full name/],
  ])('rejects %s', (_label, over, message) => {
    const r = validateSubmission({ ...valid, ...over })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.errors.join(' | ')).toMatch(message)
  })

  it('accepts an optional recipient email with email contact', () => {
    const r = validateSubmission({ ...valid, recipientEmail: 'C@x.ng', preferredContact: 'email' })
    expect(r.ok && r.value.recipientEmail).toBe('c@x.ng')
  })

  it('helpers', () => {
    expect(isE164('+2348031234567')).toBe(true)
    expect(isE164('2348031234567')).toBe(false)
    expect(normaliseNigerianPhone('+2348031234567')).toBe('+2348031234567')
    expect(normaliseNigerianPhone('+447400123456')).toBeNull()
  })
})

describe('computeFlags (duplicate / fraud signals)', () => {
  const s: NormalisedSubmission = {
    senderName: 'Ada Obi',
    senderEmail: 'ada@example.com',
    senderPhone: '+447400123456',
    recipientName: 'Chinedu Obi',
    recipientPhone: '+2348031234567',
    recipientEmail: null,
    relationship: null,
    preferredContact: null,
    termsVersion: 'v1',
  }
  const base = {
    submission: s,
    account: { email: 'Ada@example.com', phone: '+447400123456' },
    order: { status: 'FULFILLED', refunded: false, disputed: false },
    otherSubmissionsSameRecipientPhone: 0,
    otherSubmissionsSameRecipientEmail: 0,
    otherSubmissionsSameCustomer: 0,
  }

  it('raises nothing for a clean first submission', () => {
    expect(computeFlags(base)).toEqual([])
  })

  it('flags the same recipient phone nominated elsewhere (shared households are reviewed, not rejected)', () => {
    expect(computeFlags({ ...base, otherSubmissionsSameRecipientPhone: 1 })).toEqual(['DUPLICATE_RECIPIENT_PHONE'])
  })

  it('flags a recipient email already used', () => {
    expect(computeFlags({ ...base, otherSubmissionsSameRecipientEmail: 2 })).toContain('DUPLICATE_RECIPIENT_EMAIL')
  })

  it('flags the same customer submitting again', () => {
    expect(computeFlags({ ...base, otherSubmissionsSameCustomer: 1 })).toEqual(['REPEAT_SENDER'])
  })

  it('flags a recipient who is the sender', () => {
    const self = { ...s, recipientPhone: '+447400123456' }
    expect(computeFlags({ ...base, submission: self })).toContain('RECIPIENT_IS_SENDER')
  })

  it('flags sender details that differ from the account', () => {
    expect(computeFlags({ ...base, submission: { ...s, senderEmail: 'other@example.com' } })).toEqual(['SENDER_DETAILS_CHANGED'])
    expect(computeFlags({ ...base, submission: { ...s, senderPhone: '+447400123999' } })).toEqual(['SENDER_DETAILS_CHANGED'])
  })

  it('flags a qualifying order refunded or disputed after the link was issued', () => {
    expect(computeFlags({ ...base, order: { status: 'FULFILLED', refunded: true, disputed: false } })).toEqual([
      'QUALIFYING_ORDER_NOT_SETTLED',
    ])
    expect(computeFlags({ ...base, order: { status: 'REFUNDED', refunded: false, disputed: false } })).toEqual([
      'QUALIFYING_ORDER_NOT_SETTLED',
    ])
  })
})
