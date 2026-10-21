import { existsSync, readFileSync } from 'fs'
import { createRequire } from 'module'
import { join } from 'path'

/**
 * The mGBA WebAssembly build (emulator/, ADR-011) with its link cable
 * (ADR-018). Runs the real core in Node on a homebrew test program
 * (tests/fixtures/link-rom/link-test.s) — no game files involved.
 */
const CORE = join(process.cwd(), 'public/emulator/core/mgba-hub.js')
const ROM = readFileSync(join(process.cwd(), 'tests/fixtures/link-test.gba'))
const RESULTS = 0x02000000

interface Hub {
  _hub_init(n: number, rate: number, rtcMode: number, epoch: number): number
  _hub_load(i: number, rom: number, size: number, save: number, saveSize: number, patch: number, patchSize: number): number
  _hub_start(audioFrom: number): void
  _hub_set_keys(i: number, keys: number): void
  _hub_run_frame(): number
  _hub_stalls(): number
  _hub_read32(i: number, address: number): number
  _hub_hash(): number
  _hub_save_read(i: number): number
  _malloc(n: number): number
  HEAPU8: Uint8Array
}

async function boot(players: number): Promise<Hub> {
  const create = createRequire(import.meta.url)(CORE) as () => Promise<Hub>
  const hub = await create()
  expect(hub._hub_init(players, 48000, 1, Date.UTC(2026, 9, 21))).toBe(1)
  for (let i = 0; i < players; i++) {
    const ptr = hub._malloc(ROM.length)
    hub.HEAPU8.set(ROM, ptr)
    expect(hub._hub_load(i, ptr, ROM.length, 0, 0, 0, 0)).toBe(1)
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
})
