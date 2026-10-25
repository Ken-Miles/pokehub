import { newWfcUserId, signinCheck } from '@/lib/ds-console'

describe('new WFC user IDs (FR-39)', () => {
  it('are 13 digits and fit the DS firmware\'s 43 bits', () => {
    for (let i = 0; i < 200; i++) {
      const id = newWfcUserId()
      expect(id).toMatch(/^\d{13}$/)
      expect(Number(id)).toBeGreaterThan(1)
      expect(Number(id)).toBeLessThan(2 ** 43)
    }
  })
})

describe('DS sign-in check (FR-39)', () => {
  it('always lets a DS create a WFC account', () => {
    expect(signinCheck(null, 'acctcreate', undefined)).toEqual({ allow: true })
    expect(signinCheck('1234', 'ACCTCREATE', '999')).toEqual({ allow: true })
  })

  it('only lets a DS sign in with the WFC ID bound to its account', () => {
    expect(signinCheck('1234', 'login', '1234')).toEqual({ allow: true })
    expect(signinCheck('1234', 'SVCLOC', '1234')).toEqual({ allow: true })
    expect(signinCheck('1234', 'login', '5678')).toEqual({ allow: false, reason: 'other-wfc-id' })
    expect(signinCheck('1234', 'login', undefined)).toEqual({ allow: false, reason: 'other-wfc-id' })
  })

  it('refuses sign-in before any WFC ID is bound', () => {
    expect(signinCheck(null, 'login', '1234')).toEqual({ allow: false, reason: 'not-bound' })
  })
})
