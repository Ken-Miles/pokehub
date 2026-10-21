/**
 * Link-play latency spike — not part of the app.
 *
 * Serves the bench page, relays messages between the two peers of a room
 * (the "server relay" transport), carries WebRTC signalling for the
 * peer-to-peer transport, and saves results posted by the page.
 *
 *   npm run spike:link                 # http://localhost:3100, LAN: http://<this-ip>:3100
 *   RELAY_DELAY_MS=10 npm run spike:link   # hold every relayed message 10 ms (crude WAN)
 */
import { createServer } from 'http'
import { readFile, writeFile, mkdir } from 'fs/promises'
import { join, extname } from 'path'
import { networkInterfaces } from 'os'
import { Server } from 'socket.io'

const port = Number(process.env.PORT ?? 3100)
const host = process.env.HOST ?? '0.0.0.0'
const relayDelay = Number(process.env.RELAY_DELAY_MS ?? 0)
const dir = join(process.cwd(), 'spikes/link-latency')
const types: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript' }

let relayed = 0
let lastCpu = process.cpuUsage()
let lastAt = performance.now()
let stats = { cpuPct: 0, msgsPerSec: 0, sockets: 0 }

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://x')
  if (req.method === 'POST' && url.pathname === '/results') {
    let body = ''
    for await (const chunk of req) body += chunk
    const result = JSON.parse(body) as { label?: string }
    const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${(result.label ?? 'run').replace(/[^\w-]/g, '_')}.json`
    await mkdir(join(dir, 'results'), { recursive: true })
    await writeFile(join(dir, 'results', name), JSON.stringify(result, null, 2))
    res.writeHead(201).end(name)
    return
  }
  if (url.pathname === '/stats') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats))
    return
  }
  const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
  if (!/^[\w.-]+$/.test(file)) return void res.writeHead(404).end()
  try {
    const data = await readFile(join(dir, 'public', file))
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(data)
  } catch {
    res.writeHead(404).end()
  }
})

const io = new Server(server, { transports: ['websocket'] })

io.on('connection', (socket) => {
  socket.on('join', async (room: string) => {
    socket.data.room = room
    await socket.join(room)
    const peers = await io.in(room).fetchSockets()
    io.to(room).emit('peers', peers.length)
  })
  // WebRTC offer / answer / ICE candidates for the peer-to-peer transport.
  socket.on('signal', (data: unknown) => socket.to(socket.data.room).emit('signal', data))
  // Server-relay transport: forward to the other peer(s) in the room.
  socket.on('r', (msg: unknown) => {
    relayed++
    if (relayDelay > 0) setTimeout(() => socket.to(socket.data.room).emit('r', msg), relayDelay)
    else socket.to(socket.data.room).emit('r', msg)
  })
})

setInterval(() => {
  const now = performance.now()
  const cpu = process.cpuUsage(lastCpu)
  const elapsedMs = now - lastAt
  stats = {
    cpuPct: Math.round(((cpu.user + cpu.system) / 1000 / elapsedMs) * 1000) / 10,
    msgsPerSec: Math.round((relayed * 1000) / elapsedMs),
    sockets: io.engine.clientsCount,
  }
  relayed = 0
  lastCpu = process.cpuUsage()
  lastAt = now
}, 1000)

server.listen(port, host, () => {
  const lan = Object.values(networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => `http://${i!.address}:${port}`)
  console.log(`link-latency spike on http://localhost:${port}  ${lan.join('  ')}  relayDelay=${relayDelay}ms`)
})
