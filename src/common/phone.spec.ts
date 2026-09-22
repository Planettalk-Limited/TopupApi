import { toE164Digits, isValidRecipientPhone } from './phone'

describe('toE164Digits', () => {
  // Reloadly reads `recipientPhone.number` as the FULL number including the dialling
  // code, and prepends the country's code when it is missing. Every case below must
  // therefore come out as the complete E.164 digit string, no '+'.
  it.each([
    ['GB', '+447860980321', '447860980321', 'E.164 with plus'],
    ['GB', '447860980321', '447860980321', 'E.164 digits, no plus (what auto-detect sends)'],
    ['GB', '07860980321', '447860980321', 'national, trunk 0'],
    ['GB', '+44 7860 980-321', '447860980321', 'formatted with spaces and dash'],
    ['GB', '(0)7860 980321', '447860980321', 'parenthesised trunk 0'],
    ['US', '+14155550123', '14155550123', 'US E.164'],
    ['US', '4155550123', '14155550123', 'US national, no trunk prefix'],
    ['NG', '+2348012345678', '2348012345678', 'NG E.164'],
    ['NG', '08012345678', '2348012345678', 'NG national, trunk 0'],
    ['IN', '+919876543210', '919876543210', 'IN E.164'],
    ['PH', '+639171234567', '639171234567', 'PH E.164'],
    ['ZA', '+27821234567', '27821234567', 'ZA E.164'],
    ['KE', '+254712345678', '254712345678', 'KE E.164'],
    ['BR', '+5511987654321', '5511987654321', 'BR E.164'],
    ['JM', '+18761234567', '18761234567', 'JM (+1 shared code)'],
  ])('%s %s -> %s (%s)', (country, input, expected) => {
    expect(toE164Digits(input, country)).toBe(expected)
  })

  it('accepts a lowercase ISO country code', () => {
    expect(toE164Digits('07860980321', 'gb')).toBe('447860980321')
  })

  it('returns null for a number it cannot parse into a valid one', () => {
    expect(toE164Digits('12345', 'GB')).toBeNull()
    expect(toE164Digits('not a phone', 'GB')).toBeNull()
    expect(toE164Digits('', 'GB')).toBeNull()
  })

  it('returns null for a non-string input rather than stringifying it', () => {
    expect(toE164Digits(undefined as unknown as string, 'GB')).toBeNull()
    expect(toE164Digits(null as unknown as string, 'GB')).toBeNull()
  })

  it('returns null for an unknown country code instead of guessing', () => {
    expect(toE164Digits('07860980321', 'ZZ')).toBeNull()
  })

  // Ofcom reserves 07700 900xxx for drama/fiction, so no such subscriber exists and
  // Reloadly will reject it in production. It is also exactly what a tester types, and
  // it was the fixture the original executor spec used — hence worth pinning.
  it('rejects a reserved fictional range that no operator can deliver to', () => {
    expect(toE164Digits('+447700900000', 'GB')).toBeNull()
  })

  // `countryCode` on an order is the DESTINATION country: operatorId, pricing and
  // provider routing are all scoped to it. A number belonging to another country is
  // therefore not deliverable for that order, even when the number itself is perfectly
  // valid — and an explicit '+' must not be allowed to bypass the check.
  describe('the number must belong to the order country', () => {
    it('rejects a valid GB number on an NG order', () => {
      expect(toE164Digits('+447860980321', 'NG')).toBeNull()
      expect(isValidRecipientPhone('+447860980321', 'NG')).toBe(false)
    })

    it('rejects a valid NG number on a GB order', () => {
      expect(toE164Digits('+2348055512345', 'GB')).toBeNull()
    })

    it('still accepts a number that does belong to the order country', () => {
      expect(toE164Digits('+2348055512345', 'NG')).toBe('2348055512345')
      expect(toE164Digits('+447860980321', 'GB')).toBe('447860980321')
    })

    it('distinguishes countries that share the +1 dialling code', () => {
      expect(toE164Digits('+18761234567', 'JM')).toBe('18761234567')
      expect(toE164Digits('+14155550123', 'US')).toBe('14155550123')
      expect(toE164Digits('+18761234567', 'US')).toBeNull()
      expect(toE164Digits('+14155550123', 'JM')).toBeNull()
    })
  })

  // Regression guard for the production incident: the old greedy
  // /^(\d{1,3})(\d{9,10})$/ strip turned +447700900000 into 700900000, which Reloadly
  // re-prefixed to 44700900000 (one digit short) and rejected as
  // "Recipient phone number is not valid".
  it('never emits the truncated form that caused the INVALID_RECIPIENT_PHONE incident', () => {
    expect(toE164Digits('+447860980321', 'GB')).not.toBe('786098032')
    expect(toE164Digits('+14155550123', 'US')).not.toBe('155550123')
    expect(toE164Digits('08012345678', 'NG')).not.toBe('012345678')
  })
})

describe('isValidRecipientPhone', () => {
  it('accepts a real number in national and international form', () => {
    expect(isValidRecipientPhone('07860980321', 'GB')).toBe(true)
    expect(isValidRecipientPhone('+447860980321', 'GB')).toBe(true)
  })

  it('rejects a number that is too short for the country', () => {
    expect(isValidRecipientPhone('0786098', 'GB')).toBe(false)
  })

  it('rejects a blank or missing number', () => {
    expect(isValidRecipientPhone('   ', 'GB')).toBe(false)
    expect(isValidRecipientPhone(undefined as unknown as string, 'GB')).toBe(false)
  })
})
