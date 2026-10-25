// Phase 4 spike: how fast does our melonDS WebAssembly build run? Node runs the same
// V8 as Chrome, so this is Chrome's number minus the drawing. Reads the operator's own
// game file from disk; nothing is uploaded.
//
//   node spikes/ds-wifi/bench.mjs <game.nds> [frames] [core dir]
import { readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { createRequire } from 'module'

const [romPath, framesArg = '1800', coreDir = 'public/emulator/ds'] = process.argv.slice(2)
if (!romPath) throw new Error('usage: bench.mjs <game.nds> [frames] [core dir]')
const createMelonHub = createRequire(import.meta.url)(resolve(coreDir, 'melonds-hub.js'))
const hub = await createMelonHub({ print: () => {}, printErr: () => {} })

const rom = readFileSync(romPath)
const romPtr = hub._malloc(rom.length)
hub.HEAPU8.set(rom, romPtr)
if (!hub._hub_boot(romPtr, rom.length, 0, 0, 0, 0)) throw new Error('boot failed')

// Self-check of the sign-in URL rewrite (ADR-027): plant the URL in unused RAM near the end.
const planted = hub._hub_main_ram() + 0x3ff000
hub.HEAPU8.set(Buffer.from('https://nas.nintendowifi.net/ac\0'), planted)
for (let f = 0; f < 30; f++) hub._hub_run_frame()
const rewritten = Buffer.from(hub.HEAPU8.subarray(planted, planted + 32)).toString('latin1').split('\0')[0]
if (rewritten !== 'http://nas.nintendowifi.net/ac') throw new Error(`nas URL not rewritten: ${rewritten}`)

// Self-check: Wi-Fi settings kept per account come back on the next boot (FR-39).
const WIFI = 768
const wifi = hub.HEAPU8.slice(hub._hub_wifi_settings(), hub._hub_wifi_settings() + WIFI)
wifi.set([0x12, 0x34, 0x56, 0x78, 0x9a, 0x02], 0xf0) // NintendoWFCID of the first access point
const romPtr2 = hub._malloc(rom.length)
hub.HEAPU8.set(rom, romPtr2)
const wifiPtr = hub._malloc(WIFI)
hub.HEAPU8.set(wifi, wifiPtr)
if (!hub._hub_boot(romPtr2, rom.length, 0, 0, 0, wifiPtr)) throw new Error('second boot failed')
const back = hub.HEAPU8.slice(hub._hub_wifi_settings() + 0xf0, hub._hub_wifi_settings() + 0xf6)
if (Buffer.from(back).toString('hex') !== '123456789a02') throw new Error('Wi-Fi settings not restored')

const frames = Number(framesArg)
const times = []
let keys = 0
for (let f = 0; f < frames; f++) {
  // Tap A then Start now and then, so it gets past the intro screens into real game code.
  keys = f % 120 < 5 ? (f % 240 < 120 ? 1 : 8) : 0
  hub._hub_set_keys(0, keys)
  const t = performance.now()
  hub._hub_run_frame()
  times.push(performance.now() - t)
}

const steady = times.slice(Math.min(300, frames >> 2)).sort((a, b) => a - b)
const avg = steady.reduce((a, b) => a + b, 0) / steady.length
const p = (q) => steady[Math.floor(q * (steady.length - 1))].toFixed(2)
console.log(JSON.stringify({ frames, avgMs: avg.toFixed(2), fps: (1000 / avg).toFixed(1), p50: p(0.5), p95: p(0.95), p99: p(0.99) }))

// Last frame as a PPM (top screen over bottom), to check it really runs and the colours are right.
const px = new Uint8Array(hub.HEAPU8.buffer, hub._hub_video(0), 256 * 384 * 4)
const ppm = Buffer.alloc(256 * 384 * 3)
for (let i = 0; i < 256 * 384; i++) ppm.set(px.subarray(i * 4, i * 4 + 3), i * 3)
writeFileSync(process.env.PPM ?? '/dev/null', Buffer.concat([Buffer.from('P6 256 384 255\n'), ppm]))
