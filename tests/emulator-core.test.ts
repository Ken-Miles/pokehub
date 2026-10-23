import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

/**
 * The mGBA WebAssembly build (emulator/, ADR-011) with its link cable
 * (ADR-018) and the Game Boy network cable (ADR-020). Runs the real core in
 * Node on homebrew test programs (tests/fixtures/link-rom/) — no game files involved.
 */
const CORE = join(process.cwd(), 'public/emulator/core/mgba-hub.js')
const ROM = readFileSync(join(process.cwd(), 'tests/fixtures/link-test.gba'))
const RFU_ROM = readFileSync(join(process.cwd(), 'tests/fixtures/rfu-test.gba'))
const NET_ROM = readFileSync(join(process.cwd(), 'tests/fixtures/net-test.gba'))
const GB_ROM = readFileSync(join(process.cwd(), 'tests/fixtures/link-test.gb'))
// Same program as a Game Boy Color cart with MBC3 + clock + battery RAM, like Gen 2.
const GBC_ROM = readFileSync(join(process.cwd(), 'tests/fixtures/link-test-gbc.gb'))
// KEY1 (speed switch) reads 0xFF on a Game Boy and 0x7E on a Game Boy Color in colour mode.
const key1 = (hub: Hub) => hub._hub_read32(0, 0xff4d) & 0xff
const RESULTS = 0x02000000

interface Hub {
  _hub_init(platform: number, n: number, rate: number, rtcMode: number, epoch: number): number
  _hub_load(i: number, rom: number, size: number, save: number, saveSize: number, patch: number, patchSize: number): number
  _hub_start(audioFrom: number): void
  _hub_set_keys(i: number, keys: number): void
  _hub_run_frame(): number
  _hub_stalls(): number
  _hub_read32(i: number, address: number): number
  _hub_hash(): number
  _hub_save_read(i: number): number
  _hub_save_data(): number
  _hub_video_size(i: number): number
  _hub_cable_plug(on: number, seat: number, delay: number): number
  _hub_cable_put(kind: number, byte: number, seq: number): void
  _hub_cable_take(): number
  _hub_air_plug(on: number, seat: number): number
  _hub_air_inbox(): number
  _hub_air_put(op: number, from: number, n: number): void
  _hub_air_take(): number
  _hub_air_trace(): number
  _malloc(n: number): number
  HEAPU8: Uint8Array
  HEAPU32: Uint32Array
}

async function boot(players: number, platform = 0, rom = ROM, rtcMode = 1): Promise<Hub> {
  const create = createRequire(import.meta.url)(CORE) as () => Promise<Hub>
  const hub = await create()
  expect(hub._hub_init(platform, players, 48000, rtcMode, Date.UTC(2026, 9, 21))).toBe(1)
  for (let i = 0; i < players; i++) {
    const ptr = hub._malloc(rom.length)
    hub.HEAPU8.set(rom, ptr)
    expect(hub._hub_load(i, ptr, rom.length, 0, 0, 0, 0)).toBe(1)
  }
  hub._hub_start(0)
  return hub
}

function run(hub: Hub, frames: number, keys: (frame: number, player: number) => number = () => 0, players = 2) {
  for (let f = 0; f < frames; f++) {
    for (let p = 0; p < players; p++) hub._hub_set_keys(p, keys(f, p))
    hub._hub_run_frame()
  }
}

const u32 = (hub: Hub, player: number, offset: number) => hub._hub_read32(player, RESULTS + offset) >>> 0

describe.skipIf(!existsSync(CORE))('mGBA core (npm run emulator:build)', () => {
  it('two linked GBAs swap a word per transfer over the multiplayer cable', async () => {
    const hub = await boot(2)
    run(hub, 90)
    expect(u32(hub, 0, 0)).toBe(0) // parent
    expect(u32(hub, 1, 0)).toBe(4) // child
    for (const player of [0, 1]) {
      expect(u32(hub, player, 4)).toBe(16)
      for (let n = 0; n < 16; n++) {
        // Both GBAs see the same pair: the parent's word in SIOMULTI0, the child's in SIOMULTI1.
        expect(u32(hub, player, 8 + n * 4)).toBe((((0x2000 + n) << 16) | (0x1000 + n)) >>> 0)
      }
    }
    expect(hub._hub_stalls()).toBe(0)
  })

  it('is deterministic: two browsers fed the same inputs stay in step (lockstep, ADR-012)', async () => {
    const keys = (f: number, p: number) => ((f * 7 + p * 13) % 11 === 0 ? 1 << (f % 10) : 0)
    const a = await boot(2)
    const b = await boot(2)
    const hashes: [number, number][] = []
    for (let i = 0; i < 6; i++) {
      run(a, 20, keys)
      run(b, 20, keys)
      hashes.push([a._hub_hash(), b._hub_hash()])
    }
    for (const [x, y] of hashes) expect(x).toBe(y)
  })

  it('one unlinked GBA runs alone and never sees a partner', async () => {
    const hub = await boot(1)
    run(hub, 30, undefined, 1)
    expect(u32(hub, 0, 4)).toBe(0) // still waiting for the cable to be ready
    expect(hub._hub_save_read(0)).toBe(0) // the program never touches save memory
  })

  it.each([
    ['two Game Boys', GB_ROM, GB_ROM],
    ['a Game Boy and a Game Boy Color (Time Capsule)', GB_ROM, GBC_ROM],
  ])('%s in separate pages trade cable bytes over a delayed network, in order', async (_, rom0, rom1) => {
    // Two instances = two browsers. Side 1 holds A at power-on.
    const sides = [await boot(1, 1, rom0), await boot(1, 1, rom1)]
    expect(sides[0]._hub_video_size(0)).toBe((160 << 16) | 144)
    expect([key1(sides[0]), key1(sides[1])]).toEqual([0xff, rom1 === GBC_ROM ? 0x7e : 0xff])
    for (const hub of sides) expect(hub._hub_cable_plug(1, 0, 0)).toBe(1)
    // In-flight messages to each side, delivered a few frames late (FIFO, like the relay).
    const wire: { at: number; k: number; b: number; n: number }[][] = [[], []]
    const kinds: number[][] = [[], []]
    for (let frame = 0; frame < 400; frame++) {
      sides.forEach((hub, i) => {
        hub._hub_set_keys(0, i === 1 && frame < 5 ? 1 : 0)
        while (wire[i].length && wire[i][0].at <= frame) {
          const m = wire[i].shift()!
          hub._hub_cable_put(m.k, m.b, m.n)
          hub._hub_cable_put(m.k, m.b, m.n) // a duplicate is ignored
        }
        hub._hub_run_frame()
        const out = hub._hub_cable_take() >> 2
        for (let m = 0; m < hub.HEAPU32[out]; m++) {
          const [k, b, n] = hub.HEAPU32.subarray(out + 1 + m * 3, out + 4 + m * 3)
          kinds[i].push(k)
          wire[1 - i].push({ at: frame + 1 + ((frame + i) % 4), k, b, n })
        }
      })
    }
    const byte = (side: number, offset: number) => sides[side]._hub_read32(0, 0xc000 + offset) & 0xff
    expect([byte(0, 0), byte(1, 0)]).toEqual([0, 1])
    // Both clocking at once: each ends up with the other's byte.
    expect([byte(0, 1), byte(1, 1)]).toEqual([0x22, 0x11])
    for (const side of [0, 1]) {
      expect(byte(side, 2)).toBe(16)
      for (let n = 0; n < 16; n++) expect(byte(side, 3 + n)).toBe(side === 0 ? 0xc0 + n : 0x40 + n)
    }
    expect(kinds[0].filter((k) => k === 1)).toHaveLength(17) // side 0 clocked every transfer once
    expect(kinds[1].filter((k) => k === 1)).toHaveLength(1) // side 1 only in the both-clocking one
  })

  it('an unplugged Game Boy reads 0xFF from the cable and sends nothing', async () => {
    const hub = await boot(1, 1, GB_ROM)
    run(hub, 30, undefined, 1)
    // Side 0, 0xFF from the both-clocking step, then 16 rounds done alone, each reading 0xFF.
    expect(hub._hub_read32(0, 0xc000) & 0xffffff).toBe(0x10ff00)
    expect(hub._hub_read32(0, 0xc003) >>> 0).toBe(0xffffffff)
    expect(hub.HEAPU32[hub._hub_cable_take() >> 2]).toBe(0)
  })

  it.each([
    // Frames each message takes, cycling. A round trip that fits in the delay never stalls once warm.
    ['at full speed', [1, 2, 2, 1], 290],
    ['through a 20-frame hiccup', [1, 2, 2, 1, ...Array(2000).fill(1), 20], 200],
  ])('two GBAs in separate pages link over a delayed network %s, Gen 3 style (ADR-021)', async (_, LATENCY, minFrames) => {
    const DELAY = 6 // the parent's view of the child is this many frames late
    const sides = [await boot(1, 0, NET_ROM), await boot(1, 0, NET_ROM)]
    expect(sides.map((hub, seat) => hub._hub_cable_plug(1, seat, DELAY))).toEqual([1, 1])
    const wire: { at: number; k: number; b: number; n: number }[][] = [[], []]
    let sent = 0
    const ran = [0, 0]
    for (let tick = 0; tick < 300; tick++) {
      sides.forEach((hub, i) => {
        while (wire[i].length && wire[i][0].at <= tick) {
          const m = wire[i].shift()!
          hub._hub_cable_put(m.k, m.b, m.n)
          hub._hub_cable_put(m.k, m.b, m.n) // a duplicate is ignored
        }
        ran[i] += hub._hub_run_frame()
        const out = hub._hub_cable_take() >> 2
        for (let m = 0; m < hub.HEAPU32[out]; m++) {
          const [k, b, n] = hub.HEAPU32.subarray(out + 1 + m * 3, out + 4 + m * 3)
          const at = tick + LATENCY[sent++ % LATENCY.length]
          wire[1 - i].push({ at: Math.max(at, wire[1 - i].at(-1)?.at ?? 0), k, b, n }) // in order, like the relay
        }
      })
    }
    const word = (side: number, offset: number) => sides[side]._hub_read32(0, 0x02000000 + offset) >>> 0
    expect([word(0, 0), word(1, 0)]).toEqual([0, 4]) // parent, child
    expect(ran[0]).toBeGreaterThan(minFrames) // the parent waits only while the child's words are late
    for (const side of [0, 1]) {
      expect(word(side, 4)).toBeGreaterThan(minFrames - 40) // blocks: one per frame
      expect(word(side, 8)).toBe(0) // no checksum mismatch, either side
    }
    // Both games saw exactly the same transfers.
    const logged = Math.min(word(0, 12), word(1, 12))
    expect(logged).toBeGreaterThan(900)
    const log = (side: number) => Array.from({ length: logged }, (_, n) => word(side, 0x100 + n * 4))
    const [parent, child] = [log(0), log(1)]
    expect(child).toEqual(parent)
    // Every word arrived once, in order: the parent's at once, the child's after the delay (0 = not yet).
    expect(parent.map((w) => w & 0xffff)).toEqual(parent.map((_, n) => 0x1000 | ((n + 1) & 0xfff)))
    const fromChild = parent.map((w) => w >>> 16).filter((w) => w !== 0)
    expect(fromChild).toEqual(fromChild.map((_, n) => 0x2000 | ((n + 1) & 0xfff)))
    expect(fromChild.length).toBeGreaterThan(logged - 8 * (DELAY + 2))
  })

  it('a GBA cable parent waits for its child rather than run ahead of the delay', async () => {
    const hub = await boot(1, 0, NET_ROM)
    expect(hub._hub_cable_plug(1, 0, 3)).toBe(1)
    const ran = Array.from({ length: 10 }, () => hub._hub_run_frame())
    expect(ran.slice(0, 4)).toEqual([1, 1, 1, 1]) // frame 0 had no transfers; 1–3 run on the delay
    expect(ran.slice(4)).toEqual([0, 0, 0, 0, 0, 0]) // frame 4 needs the child's answer to frame 1
  })

  it('two GBAs with wireless adapters find each other, link and swap packets over a delayed network (ADR-022)', async () => {
    // Seat 0 hosts; seat 1 holds A at power-on and joins. Messages take 2–3 frames (FIFO per receiver).
    const sides = [await boot(1, 0, RFU_ROM), await boot(1, 0, RFU_ROM)]
    expect(sides.map((hub, seat) => hub._hub_air_plug(1, seat))).toEqual([1, 1])
    const wire: { at: number; op: number; from: number; d: number[] }[][] = [[], []]
    const ops: number[] = []
    for (let tick = 0; tick < 900; tick++) {
      sides.forEach((hub, seat) => {
        while (wire[seat].length && wire[seat][0].at <= tick) {
          const m = wire[seat].shift()!
          hub.HEAPU32.set(m.d, hub._hub_air_inbox() >> 2)
          hub._hub_air_put(m.op, m.from, m.d.length)
        }
        hub._hub_set_keys(0, seat === 1 && tick < 10 ? 1 : 0)
        hub._hub_run_frame()
        const out = hub._hub_air_take() >> 2
        for (let m = 0, at = out + 1; m < hub.HEAPU32[out]; m++) {
          const [op, to, n] = hub.HEAPU32.subarray(at, at + 3)
          const d = Array.from(hub.HEAPU32.subarray(at + 3, at + 3 + n))
          at += 3 + n
          ops.push(op)
          for (const peer of [0, 1]) {
            if (peer !== seat && (to === 255 || to === peer)) wire[peer].push({ at: tick + 2 + (tick % 2), op, from: seat, d })
          }
        }
      })
    }
    const word = (side: number, offset: number) => sides[side]._hub_read32(0, 0x02000000 + offset) >>> 0
    expect([word(0, 0), word(1, 0)]).toEqual([0, 1]) // host, client
    expect([word(0, 4), word(1, 4)]).toEqual([0x8001, 0x8001]) // librfu's login found the adapter again after a stop and a reset
    expect([word(0, 8), word(1, 8)]).toEqual([3, 3]) // both finished
    // librfu times out and resends a command unless every request word is answered 0x80000000, even the first after a login.
    expect([word(0, 28), word(1, 28)]).toEqual([0, 0])
    // The client found the host's beacon and got slot 0; the host saw that same child.
    expect(word(1, 16) >>> 16).toBe(0)
    expect(word(0, 16)).toBe(word(1, 16))
    // A new packet every frame, delivered in bursts: every one arrived, in order, both ways
    // (the games number their packets and drop the link after a few go missing).
    const log = (side: number) => Array.from({ length: word(side, 12) }, (_, n) => word(side, 0x100 + n * 4))
    expect(log(0)).toEqual(Array.from({ length: 64 }, (_, k) => 0x2000 + k))
    expect(log(1)).toEqual(Array.from({ length: 64 }, (_, k) => 0x1000 + k))
    expect(word(1, 24)).toBeGreaterThan(0) // the client's waits timed out while the host was quiet
    expect(word(1, 20)).toBe(1) // and it heard the host disconnect it
    expect(new Set(ops)).toEqual(new Set([1, 2, 3, 4, 6, 7])) // beacon, beacon off, join, accept, data, leave
    // Each side stopped its adapter once, which is what the page prints a trace for; then nothing new.
    sides.forEach((hub) => {
      const t = hub._hub_air_trace() >> 2
      expect(t).toBeGreaterThan(0)
      const whats = Array.from({ length: hub.HEAPU32[t] }, (_, i) => hub.HEAPU32[t + 2 + i * 4]) // events: frame, what, state, detail
      expect(whats[0]).toBe(0x3d) // the stop, still in the ring
      expect(whats).toContain(0x10) // then the reset command after logging in again
      expect(hub._hub_air_trace()).toBe(0)
    })
  })

  it('out of a wireless room the adapter stays plugged in with nobody in range (ADR-022)', async () => {
    // Pulling it from a game that's using it is a link error, and the games check for it at the Union Room
    // desk (log in, stop) and log in again on the way in, which this program does too.
    const hub = await boot(1, 0, RFU_ROM)
    hub._hub_air_plug(1, 0)
    hub._hub_air_plug(2, 0)
    for (let i = 0; i < 30; i++) hub._hub_run_frame()
    expect(hub._hub_read32(0, 0x02000004) >>> 0).toBe(0x8001) // found again after the stop
    expect(hub.HEAPU32[hub._hub_air_take() >> 2]).toBe(0) // its beacons go nowhere
  })

  it('a search hears every host in a crowded room, though one poll reports at most 4 (ADR-024)', async () => {
    // The scanner (B held at power-on) is the last of 16 seats; 10 others host, beaconing as they do every 30 frames.
    const hub = await boot(1, 0, RFU_ROM)
    hub._hub_air_plug(1, 15)
    for (let f = 0; f < 300 && hub._hub_read32(0, 0x02000008) >>> 0 !== 3; f++) {
      if (f % 30 === 0) {
        for (let seat = 0; seat < 10; seat++) {
          hub.HEAPU32.set([0x100 + seat, 1, 2, 3, 4, 5, 6], hub._hub_air_inbox() >> 2)
          hub._hub_air_put(1, seat, 7)
        }
      }
      hub._hub_set_keys(0, f < 10 ? 2 : 0)
      hub._hub_run_frame()
    }
    expect(hub._hub_read32(0, 0x02000000) >>> 0).toBe(2) // scanner
    expect(hub._hub_read32(0, 0x02000008) >>> 0).toBe(3) // done
    const heard = Array.from({ length: 16 }, (_, seat) => hub._hub_read32(0, 0x02000100 + seat * 4) >>> 0)
    expect(heard).toEqual(Array.from({ length: 16 }, (_, seat) => (seat < 10 ? 1 : 0)))
  })

  it('an MBC3 clock cart saves its 32 KB RAM plus mGBA\'s 48-byte wall-clock block', async () => {
    const hub = await boot(1, 1, GBC_ROM, 0) // wall clock, as in solo play
    expect(hub._hub_save_read(0)).toBe(0x8000) // nothing written back yet
    run(hub, 120, undefined, 1) // the program wrote cart RAM; mGBA writes it back once it settles
    const size = hub._hub_save_read(0)
    expect(size).toBe(0x8000 + 48)
    const save = hub.HEAPU8.slice(hub._hub_save_data(), hub._hub_save_data() + size)
    expect(save[0]).toBe(0x5a)
    // The block ends with the latch time in Unix seconds (64-bit LE).
    const unix = Number(new DataView(save.buffer).getBigUint64(0x8000 + 40, true))
    expect(Math.abs(unix - Date.now() / 1000)).toBeLessThan(60)
  })
})
