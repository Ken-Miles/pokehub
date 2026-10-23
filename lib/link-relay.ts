import type { Server, Socket } from 'socket.io'
import { prisma } from '@/lib/db'
import { MAX_ROOM } from '@/lib/link-rules'
import { endOrphanedLinks, endSession, seatsOf } from '@/lib/link-sessions'
import { leaveRoom } from '@/lib/wireless'
import { logger } from '@/lib/logger'
import { setPlaying } from '@/lib/realtime'

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
  /** A wireless room member (not the host): dropping out leaves the room instead of ending it. */
  roomMember: boolean
}

const booted = new Map<string, Set<string>>() // sessionId → userIds whose browsers are ready
/** Wireless rooms: sessionId → seat → socket id, so a message to one adapter reaches only that page (ADR-024). */
const airSeats = new Map<string, Map<number, string>>()

function joined(socket: Socket): Map<string, Joined> {
  socket.data.link ??= new Map<string, Joined>()
  return socket.data.link
}

const room = (sessionId: string) => `link:${sessionId}`

const CABLE_MAX: Record<number, number> = { 0: 0xff, 1: 0xff, 2: 0xffffffff, 3: 0, 4: 0xffff }

/** Messages a browser may relay: its own seats' inputs, its hashes, pings, WebRTC signalling. */
export function relayable(m: unknown, seats: Set<number>): boolean {
  if (!m || typeof m !== 'object') return false
  const msg = m as Record<string, unknown>
  if (msg.t === 'i') return seats.has(msg.p as number) && Number.isInteger(msg.f) && Number.isInteger(msg.k)
  if (msg.t === 'h') return seats.has(msg.p as number) && Number.isInteger(msg.f) && Number.isInteger(msg.h)
  if (msg.t === 'ping' || msg.t === 'pong') return typeof msg.at === 'number' && seats.has(msg.p as number)
  // Cable message (FR-34): Game Boy kind 0 ready / 1 clock with a byte (ADR-020); Gen 3 kind
  // 2 pair (two 16-bit words), 3 frame end, 4 child word (ADR-021). Sequence number n.
  if (msg.t === 'c') {
    const max = CABLE_MAX[msg.k as number]
    return seats.has(msg.p as number) && max !== undefined && Number.isInteger(msg.b) && (msg.b as number) >= 0 && (msg.b as number) <= max && Number.isInteger(msg.n)
  }
  // Wireless Adapter message (FR-35, ADR-022): op 0–15; to = one seat, 255 or absent = the whole room; ≤ 24 words.
  if (msg.t === 'a') {
    const to = msg.to
    return (
      seats.has(msg.p as number) &&
      Number.isInteger(msg.op) && (msg.op as number) >= 0 && (msg.op as number) <= 15 &&
      (to === undefined || to === 255 || (Number.isInteger(to) && (to as number) >= 0 && (to as number) < MAX_ROOM)) &&
      Array.isArray(msg.d) && msg.d.length <= 24 && msg.d.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffffffff)
    )
  }
  return false
}

export function attachLinkRelay(io: Server) {
  endOrphanedLinks()
    .then((n) => n && logger.info({ ended: n }, 'ended links left over from the last run'))
    .catch((err) => logger.warn({ err }, 'ending leftover links failed'))
  io.on('connection', (socket) => {
    // The play page says which of my slots it's running, so friends can see me online (FR-34).
    socket.on('play:here', async (slotId: unknown) => {
      if (typeof slotId !== 'string' || slotId.length > 40) return
      const mine = await prisma.gameSlot.count({ where: { id: slotId, userId: socket.data.userId, deletedAt: null } }).catch(() => 0)
      if (mine) setPlaying(socket.data.userId, socket.id, slotId)
    })

    socket.on('link:join', async (sessionId: unknown, ack?: (r: { ok: boolean; seats?: number[] }) => void) => {
      if (typeof sessionId !== 'string' || sessionId.length > 40) return ack?.({ ok: false })
      const s = await seatsOf(socket.data.userId, sessionId).catch(() => null)
      if (!s || s.state === 'ENDED') return ack?.({ ok: false })
      joined(socket).set(sessionId, { seats: new Set(s.seats), userIds: s.userIds, roomMember: s.mode === 'WIRELESS' && s.hostId !== socket.data.userId })
      if (s.mode === 'WIRELESS') {
        const seats = airSeats.get(sessionId) ?? new Map<number, string>()
        for (const seat of s.seats) seats.set(seat, socket.id) // a reused seat's new page replaces the old one
        airSeats.set(sessionId, seats)
      }
      await socket.join(room(sessionId))
      ack?.({ ok: true, seats: s.seats })
    })

    // Lockstep traffic. Volatile isn't safe here (a lost input is a stall forever), so it's ordinary emit.
    socket.on('link:msg', (sessionId: unknown, m: unknown) => {
      const j = typeof sessionId === 'string' ? joined(socket).get(sessionId) : undefined
      if (!j || !relayable(m, j.seats)) return
      // An adapter's message to one seat (join, accept, data, leave) goes to that page only; beacons go to the room.
      const { t, to } = m as { t: string; to?: number }
      if (t === 'a' && to !== undefined && to !== 255) {
        const target = airSeats.get(sessionId as string)?.get(to)
        if (target && target !== socket.id) socket.to(target).emit('link:msg', m)
        return
      }
      socket.to(room(sessionId as string)).emit('link:msg', m)
    })

    // WebRTC offer/answer/ICE between two browsers of one session. The sender's seats
    // travel with it, so a direct channel only accepts that browser's own inputs.
    socket.on('link:signal', (sessionId: unknown, data: unknown) => {
      const j = typeof sessionId === 'string' ? joined(socket).get(sessionId) : undefined
      if (!j) return
      if (JSON.stringify(data ?? null).length > 16_000) return
      socket.to(room(sessionId as string)).emit('link:signal', { from: socket.data.userId, seats: [...j.seats], data })
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
      setPlaying(socket.data.userId, socket.id, null)
      for (const [sessionId, j] of joined(socket)) {
        const seats = airSeats.get(sessionId)
        for (const seat of j.seats) if (seats?.get(seat) === socket.id) seats.delete(seat)
        if (seats?.size === 0) airSeats.delete(sessionId)
        if (j.roomMember) {
          leaveRoom(socket.data.userId, sessionId, 'disconnected').catch((err) => logger.warn({ err, sessionId }, 'room leave on disconnect failed'))
          continue
        }
        booted.get(sessionId)?.delete(socket.data.userId)
        socket.to(room(sessionId)).emit('link:peer-left', { sessionId })
        endSession(null, sessionId, 'disconnected', { onlyActive: true }).catch((err) => logger.warn({ err, sessionId }, 'link end on disconnect failed'))
      }
    })
  })
}
