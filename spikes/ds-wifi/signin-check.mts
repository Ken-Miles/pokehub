// FR-39 check against the running site + gateway: opens a real tunnel for an account, gets a
// DHCP lease, then makes sign-in calls from that lease's IP the way ds-web passes them on.
// Uses a test bot account's DS (resets its WFC binding first).
//
//   npx tsx --env-file=.env spikes/ds-wifi/signin-check.mts
import { execFileSync } from 'child_process'
import { PrismaClient } from '@prisma/client'
import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'

const prisma = new PrismaClient()
const bot = await prisma.user.findFirstOrThrow({ where: { isBot: true }, orderBy: { username: 'asc' } })
await prisma.dsConsole.deleteMany({ where: { userId: bot.id } })
const mac = dsMac(bot.id).split(':').map((h) => parseInt(h, 16))

function dhcp(type: number, extra: number[] = []): Uint8Array {
  const d = new Uint8Array(240 + 3 + extra.length + 1)
  d.set([1, 1, 6, 0, 0x12, 0x34, 0x56, 0x78])
  d.set(mac, 28)
  d.set([99, 130, 83, 99, 53, 1, type, ...extra, 255], 236)
  const udp = new Uint8Array(8 + d.length)
  udp.set([0, 68, 0, 67, udp.length >> 8, udp.length & 0xff, 0, 0])
  udp.set(d, 8)
  const ip = new Uint8Array(20 + udp.length)
  ip.set([0x45, 0, ip.length >> 8, ip.length & 0xff, 0, 0, 0, 0, 64, 17, 0, 0, 0, 0, 0, 0, 255, 255, 255, 255])
  let sum = 0
  for (let i = 0; i < 20; i += 2) sum += (ip[i] << 8) | ip[i + 1]
  while (sum >> 16) sum = (sum & 0xffff) + (sum >> 16)
  ip.set([(~sum >> 8) & 0xff, ~sum & 0xff], 10)
  ip.set(udp, 20)
  const eth = new Uint8Array(14 + ip.length)
  eth.set([255, 255, 255, 255, 255, 255, ...mac, 8, 0])
  eth.set(ip, 14)
  return eth
}

const ws = new WebSocket(`${process.env.DS_GATEWAY_URL}/?t=${tunnelTicket(bot.id, process.env.DS_GATEWAY_SECRET!)}`)
ws.binaryType = 'arraybuffer'
await new Promise((ok, fail) => ((ws.onopen = ok), (ws.onerror = fail)))
/** yiaddr of the next DHCP reply of this type. */
const reply = (type: number) =>
  new Promise<number[]>((done, fail) => {
    setTimeout(() => fail(new Error(`no DHCP reply ${type}`)), 5000)
    ws.onmessage = (e) => {
      const f = new Uint8Array(e.data as ArrayBuffer)
      if (f.length < 282 || f[23] !== 17 || f[42] !== 2) return
      for (let i = 282; i < f.length && f[i] !== 255; i += 2 + f[i + 1]) if (f[i] === 53 && f[i + 2] === type) done([...f.subarray(58, 62)])
    }
  })
const offered = reply(2)
ws.send(dhcp(1))
const ip = await offered
const acked = reply(5)
ws.send(dhcp(3, [50, 4, ...ip, 54, 4, 10, 77, 0, 1]))
await acked
const ipText = ip.join('.')

// Calls the gateway's sign-in check as ds-web does (X-Forwarded-For = the DS's IP).
const python = `
import base64, json, sys, urllib.parse, urllib.request
def call(ip, **f):
    body = urllib.parse.urlencode({k: base64.b64encode(v.encode()).decode().replace('=', '*') for k, v in f.items()}).encode()
    req = urllib.request.Request('http://127.0.0.1:8791/ac', body, {'Host': 'nas.nintendowifi.net', 'X-Forwarded-For': ip})
    raw = urllib.request.urlopen(req, timeout=10).read().decode()
    return {k: base64.b64decode(v.replace('*', '=')).decode() for k, v in urllib.parse.parse_qsl(raw)}
ip, mac = sys.argv[1], sys.argv[2]
ds = dict(gsbrcd='IRBJ', sdkver='005001', passwd='123', gamecd='IRBO', makercd='01', unitcd='0', macadr=mac, lang='01')
r = {}
r['acctcreate'] = call(ip, action='acctcreate', userid='0', **ds)
wfc = r['acctcreate'].get('userid', '')
r['login'] = call(ip, action='login', userid=wfc, **ds)
r['loginOtherId'] = call(ip, action='login', userid='9999999999999', **ds)
r['loginOtherMac'] = call(ip, action='login', userid=wfc, **dict(ds, macadr='020000000001'))
r['loginNoTunnel'] = call('10.77.250.250', action='login', userid=wfc, **ds)
print(json.dumps({k: v.get('returncd') for k, v in r.items()} | {'wfc': wfc}))
`
const out = JSON.parse(
  execFileSync('docker', ['compose', '--profile', 'ds', 'exec', '-T', 'ds-gateway', 'python3', '-', ipText, mac.map((b) => b.toString(16).padStart(2, '0')).join('')], { input: python }).toString(),
)
ws.close()
const bound = await prisma.dsConsole.findUnique({ where: { userId: bot.id } })
console.log(JSON.stringify({ lease: ipText, ...out, boundWfcUserId: bound?.wfcUserId }))
const ok =
  out.acctcreate === '002' && out.login === '001' && bound?.wfcUserId === out.wfc &&
  out.loginOtherId === '3914' && out.loginOtherMac === '3914' && out.loginNoTunnel === '3914'
await prisma.$disconnect()
if (!ok) process.exit(1)
console.log('sign-in check ok')
