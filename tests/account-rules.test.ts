import { accountBlock, emailTokenProblem, passwordSchema, usernameSchema, type AccountState } from '@/lib/account-rules'

const now = new Date('2026-10-21T12:00:00Z')
const account = (over: Partial<AccountState> = {}): AccountState => ({
  status: 'ACTIVE',
  statusReason: null,
  suspendedUntil: null,
  ...over,
})

describe('accountBlock (FR-01)', () => {
  it('lets active accounts in', () => {
    expect(accountBlock(account(), now)).toBeNull()
  })
  it('tells a banned user why', () => {
    expect(accountBlock(account({ status: 'BANNED', statusReason: 'Trading clones' }), now)).toBe(
      'This account is banned. Reason: Trading clones',
    )
  })
  it('shows when a suspension ends', () => {
    const until = new Date('2026-10-28T00:00:00Z')
    expect(accountBlock(account({ status: 'SUSPENDED', suspendedUntil: until }), now)).toMatch(/suspended until 2026-10-28/)
  })
  it('blocks an open-ended suspension', () => {
    expect(accountBlock(account({ status: 'SUSPENDED' }), now)).toBe('This account is suspended.')
  })
  it('stops blocking once a suspension has ended', () => {
    expect(accountBlock(account({ status: 'SUSPENDED', suspendedUntil: new Date('2026-10-20T00:00:00Z') }), now)).toBeNull()
  })
})

describe('emailTokenProblem (FR-01)', () => {
  const later = new Date(now.getTime() + 1000)
  it('accepts an unused, unexpired link of the right kind', () => {
    expect(emailTokenProblem({ kind: 'RESET_PASSWORD', usedAt: null, expiresAt: later }, 'RESET_PASSWORD', now)).toBeNull()
  })
  it('refuses unknown links and links of the other kind', () => {
    expect(emailTokenProblem(null, 'RESET_PASSWORD', now)).toBe('invalid')
    expect(emailTokenProblem({ kind: 'VERIFY_EMAIL', usedAt: null, expiresAt: later }, 'RESET_PASSWORD', now)).toBe('invalid')
  })
  it('is single-use', () => {
    expect(emailTokenProblem({ kind: 'VERIFY_EMAIL', usedAt: now, expiresAt: later }, 'VERIFY_EMAIL', now)).toBe('used')
  })
  it('expires', () => {
    expect(emailTokenProblem({ kind: 'VERIFY_EMAIL', usedAt: null, expiresAt: now }, 'VERIFY_EMAIL', now)).toBe('expired')
  })
})

describe('sign-up fields (FR-01)', () => {
  it('lowercases usernames and limits them to 3–20 of a–z 0–9 _', () => {
    expect(usernameSchema.parse(' Ash_Ketchum ')).toBe('ash_ketchum')
    expect(usernameSchema.safeParse('ab').success).toBe(false)
    expect(usernameSchema.safeParse('a'.repeat(21)).success).toBe(false)
    expect(usernameSchema.safeParse('ash-k').success).toBe(false)
  })
  it('needs 10+ character passwords', () => {
    expect(passwordSchema.safeParse('123456789').success).toBe(false)
    expect(passwordSchema.safeParse('1234567890').success).toBe(true)
  })
})
