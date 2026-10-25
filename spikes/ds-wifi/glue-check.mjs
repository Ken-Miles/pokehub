// FR-07 self-check of the product glue (the C API player.js uses): save size, audio rate,
// and a save state that replays exactly. Reads the operator's own game file; nothing is uploaded.
//
//   node spikes/ds-wifi/glue-check.mjs <game.nds> [core dir]
import { readFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'
import assert from 'assert'
const [romPath, coreDir = "public/emulator/ds"] = process.argv.slice(2)
const createMelonHub = createRequire(import.meta.url)(resolve(coreDir, 'melonds-hub.js'))
const hub = await createMelonHub({ print: () => {}, printErr: () => {} })
assert(hub._hub_init(2, 1, 44100, 0, 0))
const rom = readFileSync(romPath)
const p = hub._malloc(rom.length); hub.HEAPU8.set(rom, p)
assert(hub._hub_load(0, p, rom.length, 0, 0, 0, 0), 'load')
assert.equal(hub._hub_save_read(0), 0, 'no save until the game writes one')
assert.equal(hub._hub_video_size(0), (256 << 16) | 384)
let samples = 0
for (let f = 0; f < 600; f++) { hub._hub_set_keys(0, f % 60 < 3 ? 1 : 0); hub._hub_run_frame(); samples += hub.audioFrames }
console.log('samples/frame', (samples / 600).toFixed(1), 'expect ~', (44100 / 59.8261).toFixed(1))
const size = hub._hub_state_size(0); assert(size > 0, 'state size')
const st = hub._malloc(size); assert(hub._hub_state_save(0, st))
for (let f = 0; f < 120; f++) { hub._hub_set_keys(0, f % 20 < 3 ? 1 : 0); hub._hub_run_frame() }
const ram = () => Buffer.from(hub.HEAPU8.subarray(hub._hub_main_ram(), hub._hub_main_ram() + 0x400000))
const after = ram()
assert(hub._hub_state_load(0, st, size), 'state load')
for (let f = 0; f < 120; f++) { hub._hub_set_keys(0, f % 20 < 3 ? 1 : 0); hub._hub_run_frame() }
console.log('state', size, 'bytes; replay after load matches:', ram().equals(after))
