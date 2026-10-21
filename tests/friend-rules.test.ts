import { MAX_FRIENDS, checkAccept, checkFriendRequest, type Between, type FriendParty } from '@/lib/friend-rules'

const me = (over: Partial<FriendParty> = {}): FriendParty => ({ id: 'me', emailVerified: true, friendCount: 0, ...over })
const them = (over: Partial<FriendParty> = {}): FriendParty => ({ id: 'them', emailVerified: true, friendCount: 0, ...over })
const nothing: Between = { friendship: null, blocked: false }
const code = (v: ReturnType<typeof checkFriendRequest>) => (v.action === 'reject' ? v.rejection.code : v.action)

describe('checkFriendRequest (FR-03)', () => {
  it('sends a new request', () => {
    expect(code(checkFriendRequest(me(), them(), nothing))).toBe('request')
  })
  it('needs a verified email', () => {
    expect(code(checkFriendRequest(me({ emailVerified: false }), them(), nothing))).toBe('email_unverified')
  })
  it("doesn't need the other player to be verified to send", () => {
    expect(code(checkFriendRequest(me(), them({ emailVerified: false }), nothing))).toBe('request')
  })
  it('refuses yourself', () => {
    expect(code(checkFriendRequest(me(), me(), nothing))).toBe('self')
  })
  it('refuses a block either way without saying which', () => {
    const v = checkFriendRequest(me(), them(), { friendship: null, blocked: true })
    expect(code(v)).toBe('unavailable')
    expect(v.action === 'reject' && v.rejection.message).not.toMatch(/block/i)
  })
  it('accepts their pending request instead of making a second one', () => {
    expect(code(checkFriendRequest(me(), them(), { friendship: { requesterId: 'them', status: 'PENDING' }, blocked: false }))).toBe(
      'accept',
    )
  })
  it('refuses duplicates', () => {
    expect(code(checkFriendRequest(me(), them(), { friendship: { requesterId: 'me', status: 'PENDING' }, blocked: false }))).toBe(
      'already_requested',
    )
    expect(code(checkFriendRequest(me(), them(), { friendship: { requesterId: 'them', status: 'ACCEPTED' }, blocked: false }))).toBe(
      'already_friends',
    )
  })
  it(`caps both sides at ${MAX_FRIENDS} friends`, () => {
    expect(code(checkFriendRequest(me({ friendCount: MAX_FRIENDS }), them(), nothing))).toBe('friends_full')
    expect(code(checkFriendRequest(me(), them({ friendCount: MAX_FRIENDS }), nothing))).toBe('friends_full_other')
    expect(code(checkFriendRequest(me({ friendCount: MAX_FRIENDS - 1 }), them(), nothing))).toBe('request')
  })
})

describe('checkAccept (FR-03)', () => {
  const pending: Between = { friendship: { requesterId: 'them', status: 'PENDING' }, blocked: false }
  it('accepts a pending request sent to me', () => {
    expect(checkAccept(me(), them(), pending)).toBeNull()
  })
  it('needs a verified email', () => {
    expect(checkAccept(me({ emailVerified: false }), them(), pending)?.code).toBe('email_unverified')
  })
  it("can't accept my own request", () => {
    expect(checkAccept(me(), them(), { friendship: { requesterId: 'me', status: 'PENDING' }, blocked: false })?.status).toBe(404)
  })
  it('respects the cap', () => {
    expect(checkAccept(me({ friendCount: MAX_FRIENDS }), them(), pending)?.code).toBe('friends_full')
  })
})
