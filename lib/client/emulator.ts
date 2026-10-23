/**
 * The app's side of the emulator iframe (public/emulator/player.js, ADR-011).
 * Owns the frame loop: the page's clock decides when a frame is due, and a
 * frame source decides its inputs — the iframe's own devices when solo, the
 * lockstep schedule when linked (lib/client/lockstep.ts).
 */

import type { Action } from '@/lib/client/controls'

export const GBA_FPS = 59.7275
const FRAME_MS = 1000 / GBA_FPS
/** Never run more than this many frames to catch up after a hitch; drop the rest. */
const MAX_CATCH_UP = 3

export interface GameBytes {
  rom: ArrayBuffer
  save: ArrayBuffer | null
  /** An approved ROM hack's patch (ADR-014), applied by mGBA in memory. */
  patch?: ArrayBuffer | null
}

export interface BootOptions {
  /** Default 'GBA'. A GB page runs one core; its cable goes over the network (CableMessage). */
  platform?: 'GB' | 'GBA'
  games: GameBytes[]
  /** Cores this page plays (one per local player). */
  local: number[]
  /** Per-account keyboard bindings loaded before the emulator starts. */
  bindings?: Partial<Record<Action, string | null>>
  audioFrom?: number
  /** Linked games must agree on the clock: everyone starts from the session's value. */
  rtc: { mode: 'wall' } | { mode: 'fixed'; epochMs: number }
}

/**
 * One network cable message, both directions (ADR-020 GB, ADR-021 GBA): the
 * iframe posts `{ type: 'cable', ...CableMessage }` after a frame, the parent
 * sends the peer's the same way. `{ type: 'cable-plug', ...CablePlug }` plugs
 * the cable in/out.
 */
export interface CableMessage {
  /**
   * GB: 0 = ready (waiting with byte b), 1 = clock (clocking with byte b).
   * GBA: 2 = pair (parent → child; b = parent word | child word << 16),
   * 3 = end of a parent frame (b = 0), 4 = word (child → parent; b = 16-bit word).
   */
  k: 0 | 1 | 2 | 3 | 4
  /** GB: 0–255. GBA: 0–0xFFFFFFFF. */
  b: number
  /** The sender's sequence number, from 1 per plug-in; duplicates are dropped. */
  n: number
}

export interface CablePlug {
  on: boolean
  /** GBA only: 0 = parent (starts transfers), 1 = child. */
  seat?: 0 | 1
  /** GBA only, the parent's: frames its view of the child lags (1–30). Must cover a round trip, or the parent waits. */
  delay?: number
}

/**
 * Wireless Adapter (ADR-022): `{ type: 'air-plug', on, seat }` turns this
 * page's adapter on as room seat 0–4. `{ type: 'air-plug', on: false, quiet: true }` leaves
 * the room with the adapter still plugged in: pulling it from a game that's using it is a link error. The iframe posts `{ type: 'air', op, to, d }`
 * for the room after a frame; the parent hands others' in as `{ type: 'air', op, from, d }`.
 */
export interface AirMessage {
  /** 1 beacon, 2 beacon off, 3 join, 4 accept, 5 reject, 6 data, 7 leave. */
  op: number
  /** Outgoing: a room seat, or 255 = everyone in the room. */
  to?: number
  /** Incoming: the sender's room seat. */
  from?: number
  /** Up to 24 uint32 words. */
  d: number[]
}

export interface Framed {
  local: number[]
  stalls: number
  hash?: number
  skipped?: boolean
  /** A GBA cable parent held frames back for its child's words (the game slows instead of breaking). */
  waiting?: boolean
}

export interface CoreBuild {
  mgba: string
  commit: string
  emscripten: string
  sha256: string
}

type Handler = (data: Record<string, unknown>) => void

/** Typed postMessage channel to the emulator iframe. */
export class EmulatorFrame {
  private handlers = new Map<string, Set<Handler>>()
  private waiting: ((f: Framed) => void) | null = null
  private readonly onFrameLoad = () => this.send({ type: 'ping' })
  private readonly onMessage = (e: MessageEvent) => {
    if (e.origin !== location.origin || e.source !== this.frame.contentWindow || !e.data?.type) return
    if (e.data.type === 'framed' && this.waiting) {
      const resolve = this.waiting
      this.waiting = null
      resolve(e.data as Framed)
    }
    for (const h of this.handlers.get(e.data.type) ?? []) h(e.data)
  }

  constructor(private readonly frame: HTMLIFrameElement) {
    window.addEventListener('message', this.onMessage)
    // The iframe can finish loading before the parent has installed this
    // channel. Ping it now and again on load so neither ordering loses ready.
    frame.addEventListener('load', this.onFrameLoad)
    this.send({ type: 'ping' })
  }

  on(type: string, handler: Handler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set())
    this.handlers.get(type)!.add(handler)
    return () => this.handlers.get(type)?.delete(handler)
  }

  send(msg: object, transfer: Transferable[] = []) {
    this.frame.contentWindow?.postMessage(msg, location.origin, transfer)
  }

  /** Hand the games over. Copies the buffers, so the caller keeps its own. */
  boot(opts: BootOptions) {
    const games = opts.games.map((g) => ({ rom: g.rom.slice(0), save: g.save?.slice(0) ?? null, patch: g.patch?.slice(0) ?? null }))
    const transfer = games.flatMap((g) => [g.rom, g.save, g.patch].filter((b): b is ArrayBuffer => !!b))
    this.send({ type: 'boot', platform: opts.platform, games, local: opts.local, bindings: opts.bindings, audioFrom: opts.audioFrom, rtc: opts.rtc }, transfer)
    this.frame.focus()
  }

  /** Run `count` frames; `inputs` (one per core) when linked. Resolves once they've run. */
  runFrames(count: number, inputs?: number[], hash = false): Promise<Framed> {
    return new Promise((resolve) => {
      this.waiting = resolve
      this.send({ type: 'frame', count, inputs, hash })
    })
  }

  dispose() {
    window.removeEventListener('message', this.onMessage)
    this.frame.removeEventListener('load', this.onFrameLoad)
    this.handlers.clear()
  }
}

/** How many frames are due after `elapsedMs` with `debtMs` carried over; pure for tests. */
export function framesDue(elapsedMs: number, debtMs: number): { frames: number; debtMs: number } {
  let debt = debtMs + Math.max(0, elapsedMs)
  let frames = Math.floor(debt / FRAME_MS)
  debt -= frames * FRAME_MS
  if (frames > MAX_CATCH_UP) frames = MAX_CATCH_UP // a hitch or a hidden tab: don't sprint
  return { frames, debtMs: debt }
}

/**
 * Runs frames at the GBA's own rate. `step` runs one due frame and resolves
 * false when it couldn't (a lockstep stall), which leaves the frame due.
 */
export class FrameClock {
  private raf = 0
  private last = 0
  private debt = 0
  private busy = false
  private stopped = true

  constructor(private readonly step: () => Promise<boolean>) {}

  start() {
    if (!this.stopped) return
    this.stopped = false
    this.last = performance.now()
    this.debt = 0
    const tick = async (now: number) => {
      if (this.stopped) return
      this.raf = requestAnimationFrame(tick)
      if (this.busy) return
      const due = framesDue(now - this.last, this.debt)
      this.last = now
      this.debt = due.debtMs
      this.busy = true
      try {
        let ran = 0
        for (; ran < due.frames; ran++) if (!(await this.step())) break
        // A stalled frame stays due, but only one: catching up after a stall would make the game lurch.
        if (ran < due.frames) this.debt = Math.min(this.debt + FRAME_MS, FRAME_MS)
      } finally {
        this.busy = false
      }
    }
    this.raf = requestAnimationFrame(tick)
  }

  stop() {
    this.stopped = true
    cancelAnimationFrame(this.raf)
  }
}
