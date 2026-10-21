import { DesyncCheck, HASH_EVERY, Lockstep, MAX_DELAY, MIN_DELAY, delayForRoundTrip } from '@/lib/client/lockstep'

describe('Lockstep (ADR-012)', () => {
  it('runs the first `delay` frames with no keys, without waiting for anyone', () => {
    const ls = new Lockstep(2, [0], 2)
    expect(ls.take()).toEqual([0, 0])
    expect(ls.take()).toEqual([0, 0])
    expect(ls.frame).toBe(2)
  })

  it('applies keys held after frame f on frame f + delay', () => {
    const ls = new Lockstep(2, [0], 2)
    expect(ls.addLocal(0, 0x1)).toEqual({ p: 0, f: 2, k: 0x1 })
    ls.addRemote({ p: 1, f: 2, k: 0x8 })
    ls.take()
    ls.take()
    expect(ls.take()).toEqual([0x1, 0x8])
  })

  it("stalls (and counts it) until every player's keys are here", () => {
    const ls = new Lockstep(2, [0], 1)
    ls.take()
    ls.addLocal(0, 0)
    expect(ls.waitingFor()).toEqual([1])
    expect(ls.take()).toBeNull()
    expect(ls.stalls).toBe(1)
    ls.addRemote({ p: 1, f: 1, k: 0x2 })
    expect(ls.ready()).toBe(true)
    expect(ls.take()).toEqual([0, 0x2])
  })

  it("two browsers fed each other's messages agree on every frame", () => {
    const a = new Lockstep(2, [0], 3)
    const b = new Lockstep(2, [1], 3)
    const seenA: number[][] = []
    const seenB: number[][] = []
    for (let i = 0; i < 20; i++) {
      const ka = a.take()
      const kb = b.take()
      expect(ka).not.toBeNull()
      seenA.push(ka!)
      seenB.push(kb!)
      b.addRemote(a.addLocal(0, i & 0x3ff))
      a.addRemote(b.addLocal(1, (i * 7) & 0x3ff))
    }
    expect(seenA).toEqual(seenB)
  })

  it('ignores duplicates, stale frames, local players, unknown players and frames far ahead', () => {
    const ls = new Lockstep(2, [0], 1)
    ls.addRemote({ p: 1, f: 1, k: 0x4 })
    ls.addRemote({ p: 1, f: 1, k: 0x8 }) // same frame over a second transport
    ls.addRemote({ p: 0, f: 1, k: 0x1 }) // claims to be our own player
    ls.addRemote({ p: 5, f: 1, k: 0x1 })
    ls.addRemote({ p: 1, f: 10_000, k: 0x1 })
    ls.take()
    ls.addRemote({ p: 1, f: 0, k: 0x1 }) // already played
    ls.addLocal(0, 0)
    expect(ls.take()).toEqual([0, 0x4])
    expect(ls.waitingFor()).toEqual([0, 1])
  })

  it('keeps only the ten GBA key bits from peers', () => {
    const ls = new Lockstep(2, [0], 1)
    ls.addRemote({ p: 1, f: 0, k: 0 })
    ls.addRemote({ p: 1, f: 1, k: 0xffff })
    ls.take()
    ls.addLocal(0, 0)
    expect(ls.take()).toEqual([0, 0x3ff])
  })

  it('serves several local players (same device) without a network', () => {
    const ls = new Lockstep(2, [0, 1], MIN_DELAY)
    ls.take()
    ls.addLocal(0, 0x1)
    ls.addLocal(1, 0x2)
    expect(ls.take()).toEqual([0x1, 0x2])
  })

  it(`refuses a delay outside ${MIN_DELAY}–${MAX_DELAY} and keys for a remote player`, () => {
    expect(() => new Lockstep(2, [0], 0)).toThrow()
    expect(() => new Lockstep(2, [0], MAX_DELAY + 1)).toThrow()
    expect(() => new Lockstep(2, [0], 1.5)).toThrow()
    expect(() => new Lockstep(2, [0], 1).addLocal(1, 0)).toThrow()
  })
})

describe('delayForRoundTrip (NFR-13)', () => {
  it('covers half the round trip plus a frame, at least 2', () => {
    expect(delayForRoundTrip(1)).toBe(2)
    expect(delayForRoundTrip(30)).toBe(2) // 15 ms ≈ 0.9 frames → 1 + 1
    expect(delayForRoundTrip(60)).toBe(3)
  })
  it(`caps at ${MAX_DELAY} and falls back to 3 for a bad measurement`, () => {
    expect(delayForRoundTrip(10_000)).toBe(MAX_DELAY)
    expect(delayForRoundTrip(NaN)).toBe(3)
    expect(delayForRoundTrip(-1)).toBe(3)
  })
})

describe('DesyncCheck (ADR-012)', () => {
  it('passes matching hashes in either arrival order', () => {
    const d = new DesyncCheck()
    expect(d.remote(1, 120, 42)).toBeNull()
    expect(d.local(120, 42)).toBeNull()
    expect(d.local(240, 7)).toBeNull()
    expect(d.remote(1, 240, 7)).toBeNull()
  })
  it('reports the frame where a peer disagrees', () => {
    const d = new DesyncCheck()
    d.local(HASH_EVERY, 1)
    expect(d.remote(2, HASH_EVERY, 2)).toBe(HASH_EVERY)
  })
  it('checks every peer, not only the first', () => {
    const d = new DesyncCheck()
    d.remote(1, 120, 5)
    d.remote(2, 120, 6)
    expect(d.local(120, 5)).toBe(120)
  })
})
