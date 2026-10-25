// Phase 5 spike: runs a DS game in Node with its Wi-Fi tunnelled to the DS gateway (FR-38),
// driven by a script of steps, and writes screenshots. The operator's own game file is read
// from disk and never sent anywhere; only the DS's network frames go to the gateway.
//
//   npx tsx --env-file=.env spikes/ds-wifi/drive.mts <game.nds> <out dir> <steps...>
//   steps: wait:<frames>  press:<button>[:frames]  touch:<x>,<y>[:frames]  shot:<name>
//   buttons: a b select start right left up down r l x y
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { createRequire } from 'module'
import { resolve } from 'path'
import { execFileSync } from 'child_process'
import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'

const BUTTONS = ['a', 'b', 'select', 'start', 'right', 'left', 'up', 'down', 'r', 'l', 'x', 'y']
const [romPath, outDir, ...steps] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })

const hub = await createRequire(import.meta.url)(resolve('public/emulator/ds/melonds-hub.js'))({
  print: (s: string) => console.log('[ds]', s),
  printErr: () => {},
})

// Tunnel: as the page will do it, with a ticket for a made-up spike account.
const secret = process.env.DS_GATEWAY_SECRET!
const ws = new WebSocket(`${process.env.DS_GATEWAY_URL}/?t=${tunnelTicket('spike-user', secret)}`)
ws.binaryType = 'arraybuffer'
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
let sent = 0, received = 0
ws.onmessage = (e) => {
  const f = new Uint8Array(e.data as ArrayBuffer)
  const p = hub._malloc(f.length)
  hub.HEAPU8.set(f, p)
  hub._hub_net_push(p, f.length)
  hub._free(p)
  received++
}
hub.onNetSend = (ptr: number, len: number) => {
  ws.send(hub.HEAPU8.slice(ptr, ptr + len))
  sent++
}

const rom = readFileSync(romPath)
const romPtr = hub._malloc(rom.length)
hub.HEAPU8.set(rom, romPtr)
const mac = dsMac('spike-user').split(':').map((h) => parseInt(h, 16))
const macPtr = hub._malloc(6)
hub.HEAPU8.set(mac, macPtr)
if (!hub._hub_boot(romPtr, rom.length, 0, 0, macPtr, 0)) throw new Error('boot failed')

// Real time, ~60 fps, so network timeouts in the game behave as on a real DS.
async function frames(n: number) {
  for (let i = 0; i < n; i++) {
    const t = performance.now()
    hub._hub_run_frame()
    const left = 16.7 - (performance.now() - t)
    await new Promise((r) => setTimeout(r, Math.max(0, left)))
  }
}

function shot(name: string) {
  const px = new Uint8Array(hub.HEAPU8.buffer, hub._hub_video(0), 256 * 384 * 4)
  const ppm = Buffer.alloc(256 * 384 * 3)
  for (let i = 0; i < 256 * 384; i++) ppm.set(px.subarray(i * 4, i * 4 + 3), i * 3)
  const file = resolve(outDir, `${name}.ppm`)
  writeFileSync(file, Buffer.concat([Buffer.from('P6 256 384 255\n'), ppm]))
  execFileSync('sips', ['-s', 'format', 'png', file, '--out', file.replace(/\.ppm$/, '.png')], { stdio: 'ignore' })
}

for (const step of steps) {
  const [kind, arg = '', len = '6'] = step.split(':')
  if (kind === 'wait') await frames(Number(arg))
  else if (kind === 'press') {
    hub._hub_set_keys(0, 1 << BUTTONS.indexOf(arg))
    await frames(Number(len))
    hub._hub_set_keys(0, 0)
    await frames(10)
  } else if (kind === 'touch') {
    const [x, y] = arg.split(',').map(Number)
    hub._hub_touch(x, y)
    await frames(Number(len))
    hub._hub_release()
    await frames(10)
  } else if (kind === 'shot') shot(arg)
  else throw new Error(`unknown step ${step}`)
}
console.log(JSON.stringify({ framesSent: sent, framesReceived: received }))
ws.close()
