import {
  MAX_SEATS,
  checkAddOwnSeat,
  checkEnd,
  checkInvite,
  checkPickSlot,
  checkReadSeatSave,
  checkStart,
  linkable,
  nextSeat,
  type SeatState,
  type SessionState,
  type SlotForSeat,
} from '@/lib/link-rules'

const seat = (n: number, over: Partial<SeatState> = {}): SeatState => ({
  seat: n,
  userId: n === 0 ? 'host' : `p${n}`,
  slotId: `s${n}`,
  romSha1: 'abc',
  coreBuild: 'build1',
  ready: true,
  ...over,
})
const session = (over: Partial<SessionState> = {}): SessionState => ({
  id: 'L',
  hostId: 'host',
  mode: 'NETWORK',
  state: 'LOBBY',
  seats: [seat(0)],
  ...over,
})
const slot = (over: Partial<SlotForSeat> = {}): SlotForSeat => ({
  id: 'mine',
  userId: 'host',
  platform: 'GBA',
  gameCode: 'BPEE',
  deletedAt: null,
  lockedByTradeId: null,
  otherOpenSessions: 0,
  ...over,
})
const friend = { id: 'friend', friends: true, blocked: false }
const code = (r: { code: string } | null) => r?.code ?? null

describe('nextSeat (FR-26)', () => {
  it('fills the lowest free seat', () => {
    expect(nextSeat(session({ seats: [seat(0), seat(2)] }))).toBe(1)
  })
  it(`is null once all ${MAX_SEATS} seats are taken`, () => {
    expect(nextSeat(session({ seats: [0, 1, 2, 3].map((n) => seat(n)) }))).toBeNull()
  })
})

describe('checkInvite (FR-26)', () => {
  it('lets the host invite a friend into a network lobby', () => {
    expect(checkInvite(session(), 'host', friend)).toBeNull()
  })
  it('is for the host only', () => {
    expect(code(checkInvite(session(), 'p1', friend))).toBe('not_host')
  })
  it('only works before the session starts', () => {
    expect(code(checkInvite(session({ state: 'ACTIVE' }), 'host', friend))).toBe('not_in_lobby')
  })
  it('refuses same-device sessions', () => {
    expect(code(checkInvite(session({ mode: 'SAME_DEVICE' }), 'host', friend))).toBe('same_device')
  })
  it('refuses yourself', () => {
    expect(code(checkInvite(session(), 'host', { ...friend, id: 'host' }))).toBe('self')
  })
  it('needs an accepted friendship and no block either way', () => {
    expect(code(checkInvite(session(), 'host', { ...friend, friends: false }))).toBe('not_friends')
    expect(code(checkInvite(session(), 'host', { ...friend, blocked: true }))).toBe('not_friends')
  })
  it('refuses a player already in the session', () => {
    expect(code(checkInvite(session({ seats: [seat(0), seat(1, { userId: 'friend' })] }), 'host', friend))).toBe('already_invited')
  })
  it('refuses a full cable', () => {
    expect(code(checkInvite(session({ seats: [0, 1, 2, 3].map((n) => seat(n)) }), 'host', friend))).toBe('full')
  })
})

describe('checkAddOwnSeat (FR-27 same device)', () => {
  it('lets the host add a game to a same-device lobby', () => {
    expect(checkAddOwnSeat(session({ mode: 'SAME_DEVICE' }), 'host')).toBeNull()
  })
  it('refuses network sessions and other players', () => {
    expect(code(checkAddOwnSeat(session(), 'host'))).toBe('network')
    expect(code(checkAddOwnSeat(session({ mode: 'SAME_DEVICE' }), 'p1'))).toBe('not_host')
  })
  it('refuses a full cable', () => {
    expect(code(checkAddOwnSeat(session({ mode: 'SAME_DEVICE', seats: [0, 1, 2, 3].map((n) => seat(n)) }), 'host'))).toBe('full')
  })
})

describe('linkable (FR-26)', () => {
  it('takes every Gen 3 GBA game', () => {
    expect(['AXVE', 'AXPE', 'BPEE', 'BPRE', 'BPGE'].every((c) => linkable('GBA', c))).toBe(true)
  })
  it('refuses DS games and unknown codes', () => {
    expect(linkable('NDS', 'ADAE')).toBe(false)
    expect(linkable('GBA', 'ZZZE')).toBe(false)
  })
})

describe('checkPickSlot (FR-26)', () => {
  it('lets a player put their own Gen 3 slot in their seat', () => {
    expect(checkPickSlot(session(), 'host', 0, slot())).toBeNull()
  })
  it("refuses someone else's seat or slot", () => {
    expect(code(checkPickSlot(session({ seats: [seat(0), seat(1)] }), 'host', 1, slot()))).toBe('not_your_seat')
    expect(code(checkPickSlot(session(), 'host', 0, slot({ userId: 'p1' })))).toBe('not_found')
  })
  it('refuses a deleted slot as not found', () => {
    expect(code(checkPickSlot(session(), 'host', 0, slot({ deletedAt: new Date() })))).toBe('not_found')
  })
  it("refuses games that can't be linked", () => {
    expect(checkPickSlot(session(), 'host', 0, slot({ platform: 'NDS', gameCode: 'ADAE' }))).toMatchObject({ status: 422, code: 'not_linkable' })
  })
  it('refuses a slot locked by a trade', () => {
    expect(checkPickSlot(session(), 'host', 0, slot({ lockedByTradeId: 't1' }))).toMatchObject({ status: 423, code: 'slot_locked' })
  })
  it('refuses the same slot in two seats or two sessions', () => {
    const s = session({ mode: 'SAME_DEVICE', seats: [seat(0, { slotId: 'mine' }), seat(1, { userId: 'host', slotId: null })] })
    expect(code(checkPickSlot(s, 'host', 1, slot()))).toBe('slot_taken')
    expect(code(checkPickSlot(session(), 'host', 0, slot({ otherOpenSessions: 1 })))).toBe('slot_busy')
  })
  it('lets a seat keep its own slot when re-picking', () => {
    expect(checkPickSlot(session({ seats: [seat(0, { slotId: 'mine' })] }), 'host', 0, slot())).toBeNull()
  })
  it('only works in the lobby', () => {
    expect(code(checkPickSlot(session({ state: 'ENDED' }), 'host', 0, slot()))).toBe('not_in_lobby')
  })
})

describe('checkStart (FR-26, ADR-012)', () => {
  const two = (over: Partial<SeatState> = {}) => session({ seats: [seat(0), seat(1, over)] })
  it('starts when every seat is ready on the same build', () => {
    expect(checkStart(two(), 'host')).toBeNull()
  })
  it('is for the host only, in the lobby', () => {
    expect(code(checkStart(two(), 'p1'))).toBe('not_host')
    expect(code(checkStart(session({ state: 'ACTIVE', seats: two().seats }), 'host'))).toBe('not_in_lobby')
  })
  it('needs at least two games', () => {
    expect(code(checkStart(session(), 'host'))).toBe('alone')
  })
  it('needs a slot in every seat', () => {
    expect(code(checkStart(two({ slotId: null }), 'host'))).toBe('seat_empty')
  })
  it('needs every game file checked', () => {
    expect(code(checkStart(two({ ready: false }), 'host'))).toBe('not_ready')
    expect(code(checkStart(two({ romSha1: null }), 'host'))).toBe('not_ready')
  })
  it('refuses different or unknown emulator builds, since lockstep needs identical cores', () => {
    expect(code(checkStart(two({ coreBuild: 'build2' }), 'host'))).toBe('build_mismatch')
    expect(code(checkStart(session({ seats: [seat(0, { coreBuild: null }), seat(1, { coreBuild: null })] }), 'host'))).toBe('build_mismatch')
  })
})

describe('checkReadSeatSave (FR-26)', () => {
  const active = session({ state: 'ACTIVE', seats: [seat(0), seat(1)] })
  it('lets participants read starting saves while the session runs', () => {
    expect(checkReadSeatSave(active, 'p1')).toBeNull()
  })
  it('hides the session from outsiders', () => {
    expect(checkReadSeatSave(active, 'stranger')).toMatchObject({ status: 404 })
  })
  it('refuses before the start and after the end', () => {
    expect(code(checkReadSeatSave({ ...active, state: 'LOBBY' }, 'p1'))).toBe('not_active')
    expect(code(checkReadSeatSave({ ...active, state: 'ENDED' }, 'p1'))).toBe('not_active')
  })
})

describe('checkEnd (FR-26)', () => {
  it('lets any participant cut the cable', () => {
    expect(checkEnd(session({ state: 'ACTIVE', seats: [seat(0), seat(1)] }), 'p1')).toBeNull()
  })
  it('hides the session from outsiders', () => {
    expect(checkEnd(session(), 'stranger')).toMatchObject({ status: 404 })
  })
  it('refuses a session that already ended', () => {
    expect(code(checkEnd(session({ state: 'ENDED' }), 'host'))).toBe('ended')
  })
})
