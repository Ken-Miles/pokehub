import type { Server } from 'socket.io'
import { accountBlock } from '@/lib/account-rules'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { isAdmin } from '@/lib/rbac'

/**
 * Watching bots from /admin/bots (FR-36, ADR-023). A running bot sends its screen as a
 * PNG on its own socket only while some admin is watching; the site passes it on to
 * the watching admins and nobody else. Never a game file or a save: just the picture.
 *
 * One watching admin at a time can take control of a bot: their buttons replace the
 * bot's and its commands wait until control comes back. Taking and returning control
 * are audited (FR-24); button presses aren't.
 *
 * Single-process state, like the link relay: bots and watchers must share one process.
 */

const WATCHERS = 'bots:watchers'
const BOTS = 'bots'
const botRoom = (bot: string) => `bot:${bot}`
/** All twelve buttons: the GBA's ten and the DS's X and Y (bots/core.ts KEY). */
const KEYS_MAX = 0xfff
/** A DS's 256×384 RGBA PNG (a GBA's is 240×160); even an incompressible one is under this. */
export const SCREEN_MAX_BYTES = 400_000

export function screenOk(m: unknown): m is { png: Buffer; status: string } {
  if (!m || typeof m !== 'object') return false
  const { png, status } = m as Record<string, unknown>
  return Buffer.isBuffer(png) && png.length > 0 && png.length <= SCREEN_MAX_BYTES && typeof status === 'string' && status.length <= 200
}

export const keysOk = (k: unknown): k is number => Number.isInteger(k) && (k as number) >= 0 && (k as number) <= KEYS_MAX

export function attachBotWatch(io: Server) {
  // bot username → the admin socket in control
  const controllers = new Map<string, { socketId: string; username: string }>()
  const tellBot = (bot: string) => io.to(botRoom(bot)).emit('bot:control', { by: controllers.get(bot)?.username ?? null })
  const release = (bot: string, actorId: string, reason: string) => {
    controllers.delete(bot)
    tellBot(bot)
    audit({ actorId, action: 'bot.release', targetType: 'bot', targetId: bot, payload: { reason } }).catch(() => {})
  }
  const releaseAll = (socketId: string, actorId: string, reason: string) => {
    for (const [bot, c] of controllers) if (c.socketId === socketId) release(bot, actorId, reason)
  }

  const watching = () => (io.sockets.adapter.rooms.get(WATCHERS)?.size ?? 0) > 0
  let told = false
  // Leaving covers disconnects too: the adapter drops a closed socket from its rooms.
  const tell = (room: string) => {
    if (room !== WATCHERS || watching() === told) return
    told = watching()
    io.to(BOTS).emit('bots:watch', told)
  }
  io.of('/').adapter.on('join-room', tell)
  io.of('/').adapter.on('leave-room', tell)

  io.on('connection', (socket) => {
    const bot: string | undefined = socket.data.bot
    if (bot) {
      socket.join([BOTS, botRoom(bot)])
      socket.emit('bots:watch', watching())
      socket.emit('bot:control', { by: controllers.get(bot)?.username ?? null })
      // Volatile: a dropped frame is fine, a backlog of old ones isn't.
      socket.on('bot:screen', (m: unknown) => {
        if (screenOk(m)) io.to(WATCHERS).volatile.emit('bot:screen', { bot, png: m.png, status: m.status })
      })
      return
    }

    // Checked against the current role in the database, as the /admin layout does.
    socket.on('bots:watch', async (on: unknown, ack?: (r: { ok: boolean }) => void) => {
      if (on !== true) {
        releaseAll(socket.id, socket.data.userId, 'stopped watching')
        await socket.leave(WATCHERS)
        return ack?.({ ok: true })
      }
      const user = await prisma.user.findUnique({ where: { id: socket.data.userId } }).catch(() => null)
      if (!user || accountBlock(user) || !isAdmin(user.role)) return ack?.({ ok: false })
      socket.data.botAdmin = user.username
      await socket.join(WATCHERS)
      ack?.({ ok: true })
    })

    socket.on('bot:control', (bot: unknown, on: unknown, ack?: (r: { ok: boolean; message?: string }) => void) => {
      const admin: string | undefined = socket.data.botAdmin
      if (!admin || !socket.rooms.has(WATCHERS) || typeof bot !== 'string' || bot.length > 40) return ack?.({ ok: false, message: 'Only a watching admin can control bots.' })
      const held = controllers.get(bot)
      if (on !== true) {
        if (held?.socketId === socket.id) release(bot, socket.data.userId, 'returned')
        return ack?.({ ok: true })
      }
      if (held && held.socketId !== socket.id) return ack?.({ ok: false, message: `${held.username} has control of ${bot}.` })
      if (!io.sockets.adapter.rooms.get(botRoom(bot))?.size) return ack?.({ ok: false, message: `${bot} is not running.` })
      if (!held) {
        controllers.set(bot, { socketId: socket.id, username: admin })
        tellBot(bot)
        audit({ actorId: socket.data.userId, action: 'bot.control', targetType: 'bot', targetId: bot }).catch(() => {})
      }
      ack?.({ ok: true })
    })

    // Held buttons as a bitmask, sent on every change; only from the admin in control.
    socket.on('bot:keys', (bot: unknown, keys: unknown) => {
      if (typeof bot === 'string' && controllers.get(bot)?.socketId === socket.id && keysOk(keys)) io.to(botRoom(bot)).emit('bot:keys', keys)
    })

    socket.on('disconnect', () => releaseAll(socket.id, socket.data.userId, 'disconnected'))
  })
}
