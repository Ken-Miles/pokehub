// FR-38 check against a running gateway: a DHCP DISCOVER from the ticket's MAC gets an
// OFFER (with our DNS server) back through the tunnel; the same from a spoofed MAC doesn't.
//
//   npx tsx --env-file=.env spikes/ds-wifi/dhcp-check.mts
import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'

function discover(mac: number[]): Uint8Array {
  const dhcp = new Uint8Array(244)
  dhcp.set([1, 1, 6, 0, 0x12, 0x34, 0x56, 0x78]) // BOOTREQUEST, Ethernet, xid
  dhcp.set(mac, 28)
  dhcp.set([99, 130, 83, 99, 53, 1, 1, 255], 236) // magic cookie, DISCOVER, end
  const udp = new Uint8Array(8 + dhcp.length)
  udp.set([0, 68, 0, 67, (udp.length >> 8) & 0xff, udp.length & 0xff, 0, 0]) // no checksum
  udp.set(dhcp, 8)
  const ip = new Uint8Array(20 + udp.length)
  ip.set([0x45, 0, (ip.length >> 8) & 0xff, ip.length & 0xff, 0, 0, 0, 0, 64, 17, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255])
  let sum = 0
  for (let i = 0; i < 20; i += 2) sum += (ip[i] << 8) | ip[i + 1]
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  ip.set([(~sum >> 8) & 0xff, ~sum & 0xff], 10)
  ip.set(udp, 20)
  const eth = new Uint8Array(14 + ip.length)
  eth.set([255, 255, 255, 255, 255, 255, ...mac, 0x08, 0x00])
  eth.set(ip, 14)
  return eth
}

/** The DHCP message type (option 53) if this is a DHCP reply to `mac`, else 0. */
function dhcpReplyType(f: Uint8Array, mac: number[]): number {
  if (f.length < 282 || f[12] !== 8 || f[13] !== 0 || f[23] !== 17) return 0
  const d = 14 + (f[14] & 15) * 4 + 8
  if (f[d] !== 2 || mac.some((b, i) => f[d + 28 + i] !== b)) return 0
  for (let i = d + 240; i < f.length && f[i] !== 255; i += 2 + f[i + 1]) if (f[i] === 53) return f[i + 2]
  return 0
}

async function attempt(sendMac: number[], ownMac: number[]): Promise<number> {
  const ws = new WebSocket(`${process.env.DS_GATEWAY_URL}/?t=${tunnelTicket('dhcp-check', process.env.DS_GATEWAY_SECRET!)}`)
  ws.binaryType = 'arraybuffer'
  await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
  const type = await new Promise<number>((done) => {
    ws.onmessage = (e) => {
      const t = dhcpReplyType(new Uint8Array(e.data as ArrayBuffer), ownMac)
      if (t) done(t)
    }
    ws.send(discover(sendMac))
    setTimeout(() => done(0), 3000)
  })
  ws.close()
  return type
}

const mac = dsMac('dhcp-check').split(':').map((h) => parseInt(h, 16))
const own = await attempt(mac, mac)
const spoofed = await attempt([2, 0, 0, 0, 0, 1], [2, 0, 0, 0, 0, 1])
console.log(JSON.stringify({ ownMacGotOffer: own === 2, spoofedMacGotReply: spoofed !== 0 }))
if (own !== 2 || spoofed !== 0) process.exit(1)
