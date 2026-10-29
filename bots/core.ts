import { createRequire } from 'module'
import { join } from 'path'
import { deflateSync } from 'zlib'

/**
 * One GBA on our mGBA WebAssembly core (ADR-011), or one DS on our melonDS core (FR-07),
 * in Node, for a bot (FR-36). Each instance is its own module, so bots never share emulator state.
 */

const CORE = join(process.cwd(), 'public/emulator/core/mgba-hub.js')
const DS_CORE = join(process.cwd(), 'public/emulator/ds/melonds-hub.js')

interface Hub extends CoreHub {
  _hub_load(i: number, rom: number, size: number, save: number, saveSize: number, patch: number, patchSize: number): number
  _hub_start(audioFrom: number): void
  _hub_set_keys(i: number, keys: number): void
  _hub_run_frame(): number
  _hub_read32(i: number, address: number): number
  _hub_cable_plug(on: number, seat: number, delay: number): number
  _hub_cable_put(kind: number, word: number, seq: number): void
  _hub_cable_take(): number
  _hub_air_plug(on: number, seat: number): number
  _hub_air_inbox(): number
  _hub_air_put(op: number, from: number, n: number): void
  _hub_air_take(): number
  _hub_air_trace(): number
  HEAPU32: Uint32Array
}

/** Key bits, as `_hub_set_keys` takes them (public/emulator/player.js BITS); X and Y are the DS's. */
export const KEY = { A: 1, B: 2, SELECT: 4, START: 8, RIGHT: 16, LEFT: 32, UP: 64, DOWN: 128, R: 256, L: 512, X: 1024, Y: 2048 } as const
export type Button = keyof typeof KEY

/** A cable message, as the play page relays it (lib/client/emulator.ts CableMessage). */
export interface CableWord { k: number; b: number; n: number }

/** A wireless adapter message (public/emulator/player.js 'air'): op 1–7, to a room seat or 255 for all. */
export interface AirMessage { op: number; to: number; d: number[] }

const AIR_OPS = ['', 'beacon', 'beacon off', 'join', 'accept', 'reject', 'data', 'leave']

/** What both cores share (emulator/melonds/hub.cpp keeps emulator/src/hub.c's C API). */
interface CoreHub {
  _hub_init(platform: number, n: number, rate: number, rtcMode: number, epoch: number): number
  _hub_save_read(i: number): number
  _hub_save_data(): number
  _hub_video(i: number): number
  _hub_video_size(i: number): number
  _malloc(n: number): number
  HEAPU8: Uint8Array
}

async function start<T extends CoreHub>(path: string): Promise<T> {
  const create = createRequire(path)(path) as () => Promise<T> // works from tsx (CommonJS) and vitest (ESM)
  const hub = await create()
  if (!hub._hub_init(0, 1, 48000, 0, 0)) throw new Error('The emulator would not start.')
  return hub
}

function copyIn(hub: CoreHub, bytes: Uint8Array | null): number {
  if (!bytes?.length) return 0
  const ptr = hub._malloc(bytes.length)
  hub.HEAPU8.set(bytes, ptr)
  return ptr
}

abstract class Core {
  protected abstract readonly hub: CoreHub

  /** One frame with these keys held. False: the frame didn't run. */
  abstract frame(keys: number): boolean

  abstract read32(address: number): number

  read16(address: number): number {
    return (this.read32(address & ~3) >>> ((address & 2) * 8)) & 0xffff
  }

  read8(address: number): number {
    return (this.read32(address & ~3) >>> ((address & 3) * 8)) & 0xff
  }

  /** The game's save as it is now, or null before the game has written one. */
  save(): Uint8Array | null {
    const size = this.hub._hub_save_read(0)
    if (!size) return null
    const ptr = this.hub._hub_save_data()
    return this.hub.HEAPU8.slice(ptr, ptr + size)
  }

  /** The current screen as a PNG (a DS's two screens one above the other). */
  screenshot(): Buffer {
    const size = this.hub._hub_video_size(0)
    const w = size >>> 16
    const h = size & 0xffff
    const ptr = this.hub._hub_video(0)
    const rgba = this.hub.HEAPU8.subarray(ptr, ptr + w * h * 4)
    const rows = Buffer.alloc((w * 4 + 1) * h)
    for (let y = 0; y < h; y++) rows.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), y * (w * 4 + 1) + 1)
    return png(w, h, rows)
  }
}

export class Gba extends Core {
  private constructor(protected readonly hub: Hub) {
    super()
  }

  static async boot(rom: Uint8Array, save: Uint8Array | null): Promise<Gba> {
    const hub = await start<Hub>(CORE)
    if (!hub._hub_load(0, copyIn(hub, rom), rom.length, copyIn(hub, save), save?.length ?? 0, 0, 0)) throw new Error('The emulator would not load the game.')
    hub._hub_start(0)
    return new Gba(hub)
  }

  /** False: a cable parent held the frame back for its child (ADR-021). */
  frame(keys: number): boolean {
    this.hub._hub_set_keys(0, keys & 0x3ff) // a GBA has no X or Y
    return !!this.hub._hub_run_frame()
  }

  read32(address: number): number {
    return this.hub._hub_read32(0, address) >>> 0
  }

  plugCable(on: boolean, seat = 0, delay = 0): boolean {
    return !!this.hub._hub_cable_plug(on ? 1 : 0, seat, delay)
  }

  putCable(m: CableWord) {
    this.hub._hub_cable_put(m.k, m.b >>> 0, m.n)
  }

  /** Cable messages the game sent since the last call (player.js does the same after each frame). */
  takeCable(): CableWord[] {
    const at = this.hub._hub_cable_take() >> 2
    const u32 = this.hub.HEAPU32
    const out: CableWord[] = []
    for (let m = 0; m < u32[at]; m++) out.push({ k: u32[at + 1 + m * 3], b: u32[at + 2 + m * 3], n: u32[at + 3 + m * 3] })
    return out
  }

  /** Wireless adapter on as room seat `seat`, or off (quiet: still plugged in, nobody in range), as player.js plugAir. */
  plugAir(on: boolean, seat = 0, quiet = false): boolean {
    return !!this.hub._hub_air_plug(on ? 1 : quiet ? 2 : 0, seat)
  }

  /** A message from the adapter in room seat `from`. */
  putAir(op: number, from: number, d: number[]) {
    if (d.length > 24) return
    this.hub.HEAPU32.set(d.map((w) => w >>> 0), this.hub._hub_air_inbox() >> 2)
    this.hub._hub_air_put(op, from, d.length)
  }

  /** Adapter messages the game sent since the last call (player.js postAir). */
  takeAir(): AirMessage[] {
    const u32 = this.hub.HEAPU32
    const air = this.hub._hub_air_take() >> 2
    const out: AirMessage[] = []
    for (let a = 0, at = air + 1; a < u32[air]; a++) {
      const len = u32[at + 2]
      out.push({ op: u32[at], to: u32[at + 1], d: Array.from(u32.subarray(at + 3, at + 3 + len)) })
      at += 3 + len
    }
    return out
  }

  /** What led up to the game stopping the adapter or it refusing a command (player.js traceAir), or null. */
  airTrace(): string | null {
    const t = this.hub._hub_air_trace() >> 2
    if (!t) return null
    const u32 = this.hub.HEAPU32
    const hex = (n: number) => '0x' + (n >>> 0).toString(16)
    const lines: string[] = []
    for (let i = 0, at = t + 1; i < u32[t]; i++, at += 4) {
      const [frame, what, state, detail] = u32.subarray(at, at + 4)
      lines.push(`frame ${frame} state ${state}: ` +
        (what >= 0xee00 ? `command ${hex(what & 0xff)} REFUSED, code ${detail}`
          : what >= 0x100 ? `${AIR_OPS[what - 0x100]} from seat ${detail}`
          : what === 0x29 ? `woke the game: disconnected ${hex(detail)}`
          : `command ${hex(what)} → ${hex(detail)}`))
    }
    return lines.join('\n')
  }
}

interface MelonHub extends CoreHub {
  _hub_boot(rom: number, size: number, save: number, saveSize: number, mac: number, wifi: number): number
  _hub_set_keys(i: number, keys: number): void
  _hub_touch(x: number, y: number): void
  _hub_release(): void
  _hub_run_frame(): number
  _hub_main_ram(): number
  _hub_wifi_settings(): number
  _hub_net_push(data: number, size: number): void
  _free(ptr: number): void
  onNetSend?: (ptr: number, size: number) => void
  onFirmware?: () => void
}

/** The DS's Wi-Fi settings block (emulator/melonds/hub.cpp HUB_WIFI_BYTES, lib/ds-console.ts). */
const WIFI_BYTES = 768

/** One DS on melonDS: no link port; its Wi-Fi is Ethernet frames in and out (FR-38). */
export class Ds extends Core {
  /** A frame the DS sent to the network. */
  onNetSend: ((frame: Uint8Array) => void) | null = null
  /** The DS wrote its Wi-Fi settings (FR-39): read them with wifiSettings(). */
  onFirmware: (() => void) | null = null

  private constructor(protected readonly hub: MelonHub) {
    super()
    hub.onNetSend = (ptr, size) => this.onNetSend?.(hub.HEAPU8.slice(ptr, ptr + size))
    hub.onFirmware = () => this.onFirmware?.()
  }

  /** `mac` is the account's DS MAC and `wifi` its saved Wi-Fi settings (player.js dsNetwork); null for the defaults. */
  static async boot(rom: Uint8Array, save: Uint8Array | null, mac: Uint8Array | null = null, wifi: Uint8Array | null = null): Promise<Ds> {
    const hub = await start<MelonHub>(DS_CORE)
    const [m, w] = [copyIn(hub, mac), copyIn(hub, wifi?.length === WIFI_BYTES ? wifi : null)]
    const ok = hub._hub_boot(copyIn(hub, rom), rom.length, copyIn(hub, save), save?.length ?? 0, m, w) // takes the game and save
    if (m) hub._free(m)
    if (w) hub._free(w)
    if (!ok) throw new Error('The emulator would not load the game.')
    return new Ds(hub)
  }

  frame(keys: number): boolean {
    this.hub._hub_set_keys(0, keys)
    return !!this.hub._hub_run_frame()
  }

  /** Main RAM only (0x02000000–0x023FFFFF): what a bot reads game state from. */
  read32(address: number): number {
    if (address >>> 22 !== 0x02000000 >>> 22) throw new Error(`A DS bot reads main RAM only, not 0x${address.toString(16)}.`)
    const p = this.hub._hub_main_ram() + (address & 0x3ffffc)
    const h = this.hub.HEAPU8
    return (h[p] | (h[p + 1] << 8) | (h[p + 2] << 16) | (h[p + 3] << 24)) >>> 0
  }

  /** Hold the touch screen at x 0–255, y 0–191 (the lower screen) until release(). */
  touch(x: number, y: number) {
    this.hub._hub_touch(Math.max(0, Math.min(255, Math.round(x))), Math.max(0, Math.min(191, Math.round(y))))
  }

  release() {
    this.hub._hub_release()
  }

  /** A frame from the network tunnel, for the DS (copied). */
  netPush(frame: Uint8Array) {
    const ptr = copyIn(this.hub, frame)
    if (!ptr) return
    this.hub._hub_net_push(ptr, frame.length)
    this.hub._free(ptr)
  }

  wifiSettings(): Uint8Array {
    const ptr = this.hub._hub_wifi_settings()
    return this.hub.HEAPU8.slice(ptr, ptr + WIFI_BYTES)
  }
}

function png(w: number, h: number, filtered: Buffer): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(crc32(body))
    return Buffer.concat([len, body, crc])
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr.set([8, 6, 0, 0, 0], 8) // 8-bit RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
