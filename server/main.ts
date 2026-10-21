/**
 * Custom Node server: runs Next.js and shares its HTTP server with Socket.IO so
 * realtime and the app live on one port (Stork v2 pattern). `npm run dev`.
 */
// Must run before importing Next: its React server components read this Node global.
import 'next/dist/server/node-environment-baseline'
import { createServer } from 'http'
import next from 'next'
import { Server as SocketIOServer } from 'socket.io'
import { getToken } from 'next-auth/jwt'

// Load .env into process.env (Node 20.12+ built-in; no dotenv dependency).
try {
  ;(process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile()
} catch {
  /* .env optional */
}

import { CLIENT_IP_HEADER, resolveClientIp } from '@/lib/client-ip'
import { env } from '@/lib/env'
import { attachLinkRelay } from '@/lib/link-relay'
import { setIO } from '@/lib/realtime'

const dev = process.env.NODE_ENV !== 'production'
const port = Number(process.env.PORT ?? 3000)

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (header ?? '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim())
  }
  return out
}

async function main() {
  const app = next({ dev })
  const handle = app.getRequestHandler()
  await app.prepare()

  // The one place the client IP is decided (lib/client-ip.ts). Anything the
  // client sent under our header is overwritten here, before Next sees it.
  const hops = env().TRUSTED_PROXY_HOPS
  const server = createServer((req, res) => {
    req.headers[CLIENT_IP_HEADER] = resolveClientIp(req.headers['x-forwarded-for'], req.socket.remoteAddress, hops)
    return handle(req, res)
  })

  const io = new SocketIOServer(server, {
    path: '/socket.io',
    cors: { origin: process.env.NEXTAUTH_URL ?? `http://localhost:${port}`, methods: ['GET', 'POST'] },
  })

  // Same session cookie as the app; every socket joins its user's room.
  io.use(async (socket, nextFn) => {
    const req = socket.request
    const token = await getToken({
      req: { headers: req.headers, cookies: parseCookies(req.headers.cookie) } as never,
      secret: process.env.NEXTAUTH_SECRET,
    })
    if (!token?.sub) return nextFn(new Error('unauthenticated'))
    socket.data.userId = token.sub
    nextFn()
  })
  io.on('connection', (socket) => socket.join(`user:${socket.data.userId}`))
  attachLinkRelay(io)
  setIO(io)

  server.listen(port, () => {
    console.log(`\n  ▸ Pokémon Hub ready on http://localhost:${port}  (dev=${dev})\n`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
