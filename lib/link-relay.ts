import type { Server, Socket } from 'socket.io'
import { endSession, seatsOf } from '@/lib/link-sessions'
import { logger } from '@/lib/logger'

/**
 * Link-play realtime (ADR-012) on the app's Socket.IO server: lobby
 * signalling, the "everyone has booted, go" barrier, and the relay fallback
 * for lockstep inputs when two browsers can't reach each other peer to peer.
 *
 * Only small messages pass: inputs ({p, f, k}), hashes and WebRTC offers —
 * never a game file or a save. The membership check runs once on join; the
 * hot path only checks the seat against what was granted then.
 *
 * Single-process state: a session's sockets must share one process (the
 * Link play note's "session-aware routing" before running more than one).
 */

interface Joined {
  seats: Set<number>
  userIds: string[]
}

const booted = new Map<string, Set<string>>() // sessionId → userIds whose browsers are ready

function joined(socket: Socket): Map<string, Joined> {
  socket.data.link ??= new Map<string, Joined>()
  return socket.data.link
}

const room = (sessionId: string) => `link:${sessionId}`

/** Messages a browser may relay: its own seats' inputs, its hashes, pings, WebRTC signalling. */
export function relayable(m: unknown, seats: Set<number>): boolean {
  if (!m || typeof m !== 'object') return false
  const msg = m as Record<string, unknown>
  if (msg.t === 'i') return seats.has(msg.p as number) && Number.isInteger(msg.f) && Number.isInteger(msg.k)
  if (msg.t === 'h') return seats.has(msg.p as number) && Number.isInteger(msg.f) && Number.isInteger(msg.h)
  if (msg.t === 'ping' || msg.t === 'pong') return typeof msg.at === 'number' && seats.has(msg.p as number)
  return false
}

export function attachLinkRelay(io: Server) {
  io.on('connection', (socket) => {
    socket.on('link:join', async (sessionId: unknown, ack?: (r: { ok: boolean; seats?: number[] }) => void) => {
      if (typeof sessionId !== 'string' || sessionId.length > 40) return ack?.({ ok: false })
      const s = await seatsOf(socket.data.userId, sessionId).catch(() => null)
      if (!s || s.state === 'ENDED') return ack?.({ ok: false })
      joined(socket).set(sessionId, { seats: new Set(s.seats), userIds: s.userIds })
      await socket.join(room(sessionId))
      ack?.({ ok: true, seats: s.seats })
    })

    // Lockstep traffic. Volatile isn't safe here (a lost input is a stall forever), so it's ordinary emit.
    socket.on('link:msg', (sessionId: unknown, m: unknown) => {
      const j = typeof sessionId === 'string' ? joined(socket).get(sessionId) : undefined
      if (!j || !relayable(m, j.seats)) return
      socket.to(room(sessionId as string)).emit('link:msg', m)
    })

    // WebRTC offer/answer/ICE between two browsers of one session.
    socket.on('link:signal', (sessionId: unknown, data: unknown) => {
      if (typeof sessionId !== 'string' || !joined(socket).has(sessionId)) return
      if (JSON.stringify(data ?? null).length > 16_000) return
      socket.to(room(sessionId)).emit('link:signal', { from: socket.data.userId, data })
    })

    // Every browser loaded every game: start frame 0 together.
    socket.on('link:booted', (sessionId: unknown) => {
      const j = typeof sessionId === 'string' ? joined(socket).get(sessionId) : undefined
      if (!j) return
      const set = booted.get(sessionId as string) ?? new Set<string>()
      set.add(socket.data.userId)
      booted.set(sessionId as string, set)
      if (j.userIds.every((u) => set.has(u))) {
        booted.delete(sessionId as string)
        io.to(room(sessionId as string)).emit('link:go', { sessionId })
      }
    })

    // A browser leaving cuts the cable for everyone (FR-26: the games show their own link error).
    socket.on('disconnect', () => {
      for (const sessionId of joined(socket).keys()) {
        booted.get(sessionId)?.delete(socket.data.userId)
        socket.to(room(sessionId)).emit('link:peer-left', { sessionId })
        endSession(null, sessionId, 'disconnected', { onlyActive: true }).catch((err) => logger.warn({ err, sessionId }, 'link end on disconnect failed'))
      }
    })
  })
}
