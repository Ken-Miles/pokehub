// FR-38 Mac bridge: desktop melonDS (Direct mode) joins the DS network as a site account's DS.
// melonDS reads and writes Ethernet frames on feth0; mac-bpf.py (sudo) carries feth1's frames
// over stdin/stdout, and this script sends them through the account's gateway tunnel.
//
//   npx tsx --env-file=.env spikes/ds-wifi/mac-bridge.mts <username> [--firmware <your firmware.bin>]
//
// The gateway only forwards the account's MAC, and melonDS's MAC override clears the 02: bit
// that MAC has, so --firmware writes a copy of your own firmware dump (<name>.hub.bin) with
// the account's MAC in it. Load that copy in melonDS and leave its MAC override field empty.
import { spawn } from 'child_process'
import { readFileSync, writeFileSync } from 'fs'
import { PrismaClient } from '@prisma/client'
import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'

/** CRC-16/ARC: the DS firmware's Wi-Fi settings checksum (melonDS SPI.cpp CRC16, start 0). */
function crc16(data: Uint8Array): number {
  let s = 0
  for (const x of data) {
    s ^= x
    for (let j = 0; j < 8; j++) s = s & 1 ? (s >>> 1) ^ 0xa001 : s >>> 1
  }
  return s
}

/** A copy of the firmware with `mac` at 0x36 and the Wi-Fi settings checksum (0x2A, over 0x2C + length) redone. */
function withMac(firmware: Uint8Array, mac: number[]): Uint8Array {
  const out = new Uint8Array(firmware)
  const view = new DataView(out.buffer)
  const len = view.getUint16(0x2c, true)
  if (out.length < 0x200 || len < 0x10 || 0x2c + len > out.length) throw new Error('not a DS firmware dump')
  out.set(mac, 0x36)
  view.setUint16(0x2a, crc16(out.subarray(0x2c, 0x2c + len)), true)
  return out
}

const [username, flag, firmwarePath] = process.argv.slice(2)
if (username === '--self-check') {
  const fw = new Uint8Array(512)
  fw.set([0x38, 0x01], 0x2c) // Wi-Fi settings length 0x138
  const out = withMac(fw, [2, 1, 2, 3, 4, 5])
  const ok =
    crc16(new TextEncoder().encode('123456789')) === 0xbb3d &&
    out[0x36] === 2 && out[0x3b] === 5 && fw[0x36] === 0 &&
    (out[0x2a] | (out[0x2b] << 8)) === crc16(out.subarray(0x2c, 0x2c + 0x138))
  console.log(ok ? 'ok' : 'FAILED')
  process.exit(ok ? 0 : 1)
}
if (!username || (flag && (flag !== '--firmware' || !firmwarePath))) {
  console.error('usage: mac-bridge.mts <username> [--firmware <firmware.bin>]')
  process.exit(2)
}
const prisma = new PrismaClient()
const user = await prisma.user.findUniqueOrThrow({ where: { username } })
await prisma.$disconnect()
const macText = dsMac(user.id)
const mac = macText.split(':').map((h) => parseInt(h, 16))
console.error(`${username}'s DS MAC: ${macText}`)
if (firmwarePath) {
  const copy = firmwarePath.replace(/(\.bin)?$/i, '.hub.bin')
  writeFileSync(copy, withMac(readFileSync(firmwarePath), mac))
  console.error(`wrote ${copy}`)
}

const helper = spawn('sudo', ['python3', new URL('./mac-bpf.py', import.meta.url).pathname], { stdio: ['pipe', 'pipe', 'inherit'] })
helper.on('exit', (code) => process.exit(code ?? 1))
// shortcut: the 60 s ticket opens one tunnel and a drop ends the bridge; rerun it to reconnect.
const ws = new WebSocket(`${process.env.DS_GATEWAY_URL}/?t=${tunnelTicket(user.id, process.env.DS_GATEWAY_SECRET!)}`)
ws.binaryType = 'arraybuffer'
ws.onopen = () => console.error('tunnel open')
ws.onclose = (e) => {
  console.error(`tunnel closed (${e.code} ${e.reason})`)
  helper.kill()
}
ws.onmessage = (e) => {
  const f = new Uint8Array(e.data as ArrayBuffer)
  const head = Buffer.alloc(2)
  head.writeUInt16BE(f.length)
  helper.stdin.write(Buffer.concat([head, f]))
}

let pending = Buffer.alloc(0)
helper.stdout.on('data', (chunk: Buffer) => {
  pending = Buffer.concat([pending, chunk])
  while (pending.length >= 2 && pending.length >= 2 + pending.readUInt16BE(0)) {
    const f = pending.subarray(2, 2 + pending.readUInt16BE(0))
    pending = pending.subarray(2 + f.length)
    // Only the DS's frames: the Mac's own chatter on the feth pair would just be dropped by the gateway.
    if (ws.readyState === WebSocket.OPEN && f.length >= 14 && mac.every((b, i) => f[6 + i] === b)) ws.send(f)
  }
})
