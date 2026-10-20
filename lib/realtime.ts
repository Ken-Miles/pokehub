import type { Server } from 'socket.io'

/**
 * Socket.IO lives on the custom server (server/main.ts). Route handlers run in
 * the same process and reach it through this holder.
 */
const holder = globalThis as unknown as { io?: Server }

export function setIO(io: Server) {
  holder.io = io
}

export function emitToUser(userId: string, event: string, payload: unknown) {
  holder.io?.to(`user:${userId}`).emit(event, payload)
}
