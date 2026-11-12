import {
  assertTransition,
  canTransition,
  customerRejectionReason,
  customerStatusLabel,
  GiftTransitionError,
  SUBMISSION_STATUSES,
  TRANSITIONS,
} from './gift-status'

describe('gift submission status workflow', () => {
  it('defines transitions for every status, only to known statuses', () => {
    for (const s of SUBMISSION_STATUSES) {
      expect(TRANSITIONS[s]).toBeDefined()
      for (const to of TRANSITIONS[s]) expect(SUBMISSION_STATUSES).toContain(to)
    }
  })

  it('never lets a submission skip review straight to approval-free fulfilment', () => {
    expect(canTransition('SUBMITTED', 'APPROVED')).toBe(false)
    expect(canTransition('PENDING_VALIDATION', 'FULFILLED')).toBe(false)
    expect(canTransition('PENDING_VALIDATION', 'AWAITING_REDEMPTION')).toBe(false)
    expect(canTransition('APPROVED', 'FULFILLED')).toBe(false)
    expect(canTransition('REJECTED', 'APPROVED')).toBe(false)
  })

  it('allows the happy path', () => {
    const path = ['SUBMITTED', 'PENDING_VALIDATION', 'APPROVED', 'RECIPIENT_CONTACTED', 'AWAITING_REDEMPTION', 'FULFILLED', 'SENDER_NOTIFIED'] as const
    for (let i = 1; i < path.length; i++) expect(canTransition(path[i - 1], path[i])).toBe(true)
  })

  it('treats SENDER_NOTIFIED and CANCELLED as terminal', () => {
    expect(TRANSITIONS.SENDER_NOTIFIED).toEqual([])
    expect(TRANSITIONS.CANCELLED).toEqual([])
  })

  it('lets a disputed rejection be escalated and an escalation be resolved either way', () => {
    expect(canTransition('REJECTED', 'ESCALATED')).toBe(true)
    expect(canTransition('ESCALATED', 'APPROVED')).toBe(true)
    expect(canTransition('ESCALATED', 'REJECTED')).toBe(true)
  })

  it('requires a valid reason code to reject, escalate or cancel', () => {
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED')).toThrow(GiftTransitionError)
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED', 'NOT_A_CODE')).toThrow(/not valid/)
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED', 'FRAUD_REVIEW')).toThrow(/not valid/)
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED', 'DUPLICATE_RECIPIENT')).not.toThrow()
    expect(() => assertTransition('PENDING_VALIDATION', 'ESCALATED', 'FRAUD_REVIEW')).not.toThrow()
    expect(() => assertTransition('APPROVED', 'CANCELLED', 'SENDER_REQUEST')).not.toThrow()
  })

  it('requires a note with OTHER', () => {
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED', 'OTHER')).toThrow(/note/)
    expect(() => assertTransition('PENDING_VALIDATION', 'REJECTED', 'OTHER', 'explained')).not.toThrow()
  })

  it('refuses a reason code where none applies', () => {
    expect(() => assertTransition('PENDING_VALIDATION', 'APPROVED', 'DUPLICATE_RECIPIENT')).toThrow(/does not take/)
  })

  it('requires evidence to mark a gift fulfilled', () => {
    expect(() => assertTransition('AWAITING_REDEMPTION', 'FULFILLED')).toThrow(/evidence/)
    expect(() => assertTransition('AWAITING_REDEMPTION', 'FULFILLED', null, 'Recipient confirmed by phone')).not.toThrow()
  })

  it('rejects illegal moves', () => {
    expect(() => assertTransition('CANCELLED', 'APPROVED')).toThrow(/Cannot move/)
  })

  it('never tells the sender a pending gift is confirmed', () => {
    for (const s of ['SUBMITTED', 'PENDING_VALIDATION', 'ESCALATED'] as const) {
      expect(customerStatusLabel(s)).toMatch(/being checked/)
      expect(customerStatusLabel(s)).not.toMatch(/confirm|approved|delivered/i)
    }
  })

  it('keeps fraud reasons vague for customers', () => {
    expect(customerRejectionReason('SUSPECTED_FRAUD')).toBeNull()
    expect(customerRejectionReason('DUPLICATE_RECIPIENT')).toMatch(/already been nominated/)
  })
})
