/**
 * Lockstep input schedule for link play (ADR-012). Every browser in a session
 * runs every player's GBA; only key presses travel. Framework-free and
 * unit-tested (tests/lockstep.test.ts).
 *
 * The keys a player holds when frame f finishes are used for frame f + delay,
 * on every browser at once. Frames before `delay` use "no keys". Frame n runs
 * only when every player's keys for n are here; until then it stalls — the
 * network shows up as input delay, never as a game running at a different
 * speed. delay = 1 is solo play's own timing (same device, no network).
 */

export interface InputMessage {
  /** Player (core index). */
  p: number
  /** Frame the keys are for. */
  f: number
  /** GBA key bits. */
  k: number
}

export const MIN_DELAY = 1
export const MAX_DELAY = 6
/** How many frames past the next one a peer may run ahead before we treat it as broken. */
const MAX_AHEAD = 600

export class Lockstep {
  /** Next frame to run. */
  frame = 0
  /** Ticks on which the next frame couldn't run yet (NFR-13 counts these). */
  stalls = 0
  private readonly inputs: Map<number, number>[]
  private readonly nextLocal = new Map<number, number>()

  constructor(
    readonly players: number,
    readonly local: number[],
    readonly delay: number,
  ) {
    if (!Number.isInteger(delay) || delay < MIN_DELAY || delay > MAX_DELAY) throw new Error(`delay must be ${MIN_DELAY}–${MAX_DELAY}`)
    this.inputs = Array.from({ length: players }, () => new Map<number, number>())
    for (const inputs of this.inputs) for (let f = 0; f < delay; f++) inputs.set(f, 0)
    for (const p of local) this.nextLocal.set(p, delay)
  }

  /** Keys local player `p` held after the frame that just ran. Returns what to send to the peers. */
  addLocal(p: number, keys: number): InputMessage {
    const f = this.nextLocal.get(p)
    if (f === undefined) throw new Error(`player ${p} isn't local`)
    this.nextLocal.set(p, f + 1)
    this.inputs[p].set(f, keys)
    return { p, f, k: keys }
  }

  /** A peer's input. Duplicates (the same frame over two transports) and stale frames are ignored. */
  addRemote(msg: InputMessage): void {
    if (!Number.isInteger(msg.p) || msg.p < 0 || msg.p >= this.players || this.nextLocal.has(msg.p)) return
    if (!Number.isInteger(msg.f) || msg.f < this.frame || msg.f > this.frame + MAX_AHEAD) return
    if (!this.inputs[msg.p].has(msg.f)) this.inputs[msg.p].set(msg.f, msg.k & 0x3ff)
  }

  ready(): boolean {
    return this.inputs.every((m) => m.has(this.frame))
  }

  /** Every player's keys for the next frame, and move on; null (a stall) if someone's are missing. */
  take(): number[] | null {
    if (!this.ready()) {
      this.stalls++
      return null
    }
    const keys = this.inputs.map((m) => {
      const k = m.get(this.frame)!
      m.delete(this.frame)
      return k
    })
    this.frame++
    return keys
  }

  /** Players whose keys for the next frame haven't arrived (shown as "waiting for …"). */
  waitingFor(): number[] {
    return this.inputs.flatMap((m, p) => (m.has(this.frame) ? [] : [p]))
  }
}

/** Input delay from a measured round trip: enough frames for half of it, plus one for jitter. */
export function delayForRoundTrip(rttMs: number, frameMs = 1000 / 59.7275): number {
  if (!Number.isFinite(rttMs) || rttMs < 0) return 3
  return Math.min(MAX_DELAY, Math.max(2, Math.ceil(rttMs / 2 / frameMs) + 1))
}

/** Every `HASH_EVERY` frames each browser posts a hash of all its GBAs; a mismatch is a desync. */
export const HASH_EVERY = 120

export class DesyncCheck {
  private readonly mine = new Map<number, number>()
  private readonly theirs = new Map<number, Map<number, number>>()

  /** Our hash after `frame`; returns the frame that disagrees with a peer, if any. */
  local(frame: number, hash: number): number | null {
    this.mine.set(frame, hash)
    return this.compare(frame)
  }

  remote(peer: number, frame: number, hash: number): number | null {
    if (!this.theirs.has(peer)) this.theirs.set(peer, new Map())
    this.theirs.get(peer)!.set(frame, hash)
    return this.compare(frame)
  }

  private compare(frame: number): number | null {
    const mine = this.mine.get(frame)
    if (mine === undefined) return null
    for (const peer of this.theirs.values()) {
      const h = peer.get(frame)
      if (h !== undefined && h !== mine) return frame
    }
    // Keep a minute's worth; older frames can't be compared usefully any more.
    for (const f of this.mine.keys()) if (f < frame - HASH_EVERY * 30) this.mine.delete(f)
    return null
  }
}
