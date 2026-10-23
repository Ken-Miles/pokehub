import type { Server } from 'socket.io'

/**
 * Socket.IO lives on the custom server (server/main.ts). Route handlers run in
 * the same process and reach it through this holder.
 */
const holder = globalThis as unknown as { io?: Server; playing?: Map<string, Map<string, string>> }

export function setIO(io: Server) {
  holder.io = io
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  holder.io?.to(`user:${userId}`).emit(event, payload)
}

/** Everyone joined to a link session's relay room (lib/link-relay.ts). */
export function emitToLinkRoom(sessionId: string, event: string, payload: unknown) {
  holder.io?.to(`link:${sessionId}`).emit(event, payload)
}

// Who has a play page open, and on which slot (FR-34 online friends): userId → socketId → slotId.
// shortcut: per process, like the link relay; needs a shared store (Redis) before running more than one.
const playing = (holder.playing ??= new Map())

export function setPlaying(userId: string, socketId: string, slotId: string | null) {
  const mine = playing.get(userId) ?? new Map<string, string>()
  if (slotId) mine.set(socketId, slotId)
  else mine.delete(socketId)
  if (mine.size) playing.set(userId, mine)
  else playing.delete(userId)
}

/** The slots a user is playing right now, newest page last. */
export function playingSlots(userId: string): string[] {
  return [...(playing.get(userId)?.values() ?? [])]
}
