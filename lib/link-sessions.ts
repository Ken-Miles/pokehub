import type { LinkMode, Prisma, User } from '@prisma/client'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { findPlayer, isBlockedEitherWay } from '@/lib/friends'
import { identifyGame } from '@/lib/games'
import { HttpError } from '@/lib/http'
import {
  LINK_GRACE_MS,
  LOBBY_TTL_MS,
  checkAddOwnSeat,
  checkEnd,
  checkInvite,
  checkPickSlot,
  checkReadSeatSave,
  checkStart,
  nextSeat,
  type EndReason,
  type SessionState,
} from '@/lib/link-rules'
import { MAX_DELAY, MIN_DELAY } from '@/lib/client/lockstep'
import { emitToUser } from '@/lib/realtime'
import { checkRom, romRejectionMessage } from '@/lib/rom-allowlist'
import type { Rejection } from '@/lib/save-rules'
import { getSave } from '@/lib/storage'

type Tx = Prisma.TransactionClient

/**
 * Link sessions (FR-26). Rules live in lib/link-rules.ts; this file loads the
 * state they need and applies the outcome in one transaction, with the session
 * row locked so two players acting at once can't both take the last seat.
 * The cable itself never passes through here: lib/link-relay.ts carries inputs.
 */

const fail = (r: Rejection | null) => {
  if (r) throw HttpError.from(r)
}

export async function lockState(tx: Tx, sessionId: string): Promise<SessionState> {
  await tx.$queryRaw`SELECT id FROM link_sessions WHERE id = ${sessionId} FOR UPDATE`
  const s = await tx.linkSession.findUnique({ where: { id: sessionId }, include: { seats: true } })
  if (!s) throw new HttpError(404, 'not_found', 'Link session not found.')
  return {
    id: s.id,
    hostId: s.hostId,
    mode: s.mode,
    state: s.state,
    seats: s.seats.map((x) => ({
      seat: x.seat,
      userId: x.userId,
      slotId: x.slotId,
      romSha1: x.romSha1,
      coreBuild: x.coreBuild,
      ready: !!x.readyAt,
      left: !!x.leftAt,
    })),
  }
}

export async function slotForSeat(tx: Tx, slotId: string, sessionId: string | null) {
  const slot = await tx.gameSlot.findUnique({ where: { id: slotId } })
  if (!slot) throw new HttpError(404, 'not_found', 'Slot not found.')
  const otherOpenSessions = await tx.linkSeat.count({
    where: { slotId, leftAt: null, session: { state: { in: ['LOBBY', 'ACTIVE'] }, ...(sessionId ? { id: { not: sessionId } } : {}) } },
  })
  return { ...slot, otherOpenSessions }
}

export function notify(userIds: Iterable<string>, sessionId: string, event = 'link:updated') {
  for (const id of new Set(userIds)) emitToUser(id, event, { sessionId })
}

/** Open a lobby with the host's slot in seat 0 (the cable's parent). */
export async function createSession(me: User, mode: LinkMode, slotId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const slot = await slotForSeat(tx, slotId, null)
    const draft: SessionState = { id: '', hostId: me.id, mode, state: 'LOBBY', seats: [{ seat: 0, userId: me.id, slotId: null, romSha1: null, coreBuild: null, ready: false }] }
    fail(checkPickSlot(draft, me.id, 0, slot))
    const s = await tx.linkSession.create({ data: { hostId: me.id, mode, seats: { create: { seat: 0, userId: me.id, slotId } } } })
    await audit({ actorId: me.id, action: 'link.create', targetType: 'link_session', targetId: s.id, payload: { mode, slotId } }, tx)
    return s.id
  })
}

/** NETWORK: give a friend the next seat; they pick their own game. */
export async function inviteToSession(me: User, sessionId: string, to: string): Promise<void> {
  const them = await findPlayer(to)
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    const [friendship, blocked] = await Promise.all([
      tx.friendship.findFirst({
        where: { status: 'ACCEPTED', OR: [{ requesterId: me.id, addresseeId: them.id }, { requesterId: them.id, addresseeId: me.id }] },
      }),
      isBlockedEitherWay(me.id, them.id, tx),
    ])
    fail(checkInvite(s, me.id, { id: them.id, friends: !!friendship, blocked }))
    await tx.linkSeat.create({ data: { sessionId, seat: nextSeat(s)!, userId: them.id } })
    return s.seats.map((x) => x.userId)
  })
  notify(userIds, sessionId)
  notify([them.id], sessionId, 'link:invite')
}

/** SAME_DEVICE: the host plugs another of their own games into the cable. */
export async function addOwnSeat(me: User, sessionId: string, slotId: string): Promise<void> {
  await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    fail(checkAddOwnSeat(s, me.id))
    const seat = nextSeat(s)!
    const withSeat: SessionState = { ...s, seats: [...s.seats, { seat, userId: me.id, slotId: null, romSha1: null, coreBuild: null, ready: false }] }
    fail(checkPickSlot(withSeat, me.id, seat, await slotForSeat(tx, slotId, sessionId)))
    await tx.linkSeat.create({ data: { sessionId, seat, userId: me.id, slotId } })
  })
  notify([me.id], sessionId)
}

/**
 * A player chooses the game for their seat and, once their browser has
 * loaded and checked the game file, marks it ready with the file's SHA-1
 * (never the file) and the emulator build it runs. Changing the game clears ready.
 */
export async function updateSeat(
  me: User,
  sessionId: string,
  seat: number,
  input: { slotId: string; romSha1?: string; coreBuild?: string },
): Promise<void> {
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    const slot = await slotForSeat(tx, input.slotId, sessionId)
    fail(checkPickSlot(s, me.id, seat, slot))
    let ready: { romSha1: string; coreBuild: string; readyAt: Date } | null = null
    if (input.romSha1 && input.coreBuild) {
      const verdict = checkRom(slot.platform, slot.gameCode, input.romSha1)
      if (!verdict.ok) throw new HttpError(422, verdict.reason, romRejectionMessage(verdict.reason, slot.platform))
      ready = { romSha1: input.romSha1.toLowerCase(), coreBuild: input.coreBuild, readyAt: new Date() }
    }
    await tx.linkSeat.update({
      where: { sessionId_seat: { sessionId, seat } },
      data: { slotId: slot.id, ...(ready ?? { romSha1: null, coreBuild: null, readyAt: null }) },
    })
    return s.seats.map((x) => x.userId)
  })
  notify(userIds, sessionId)
}

/** Plug the cable in: pin every seat's save version, the clock and the input delay. */
export async function startSession(me: User, sessionId: string, inputDelay: number): Promise<void> {
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    fail(checkStart(s, me.id))
    const delay = s.mode === 'SAME_DEVICE' ? 1 : Math.min(MAX_DELAY, Math.max(MIN_DELAY + 1, Math.round(inputDelay)))
    for (const seat of s.seats) {
      const slot = await tx.gameSlot.findUniqueOrThrow({ where: { id: seat.slotId! } })
      if (slot.deletedAt || slot.lockedByTradeId) throw new HttpError(409, 'slot_busy', 'One of the games is no longer available.')
      await tx.linkSeat.update({ where: { sessionId_seat: { sessionId, seat: seat.seat } }, data: { startVersionId: slot.currentVersionId } })
    }
    await tx.linkSession.update({
      where: { id: sessionId },
      data: { state: 'ACTIVE', startedAt: new Date(), rtcEpochMs: BigInt(Date.now()), inputDelay: delay, coreBuild: s.seats[0].coreBuild },
    })
    await audit(
      { actorId: me.id, action: 'link.start', targetType: 'link_session', targetId: sessionId, payload: { seats: s.seats.map((x) => x.slotId), delay } },
      tx,
    )
    return s.seats.map((x) => x.userId)
  })
  notify(userIds, sessionId)
}

/**
 * Cut the cable for everyone. `actorId` null = the server (disconnect,
 * sweeper); `onlyActive` leaves a lobby open (a reload there isn't a cut cable).
 */
export async function endSession(actorId: string | null, sessionId: string, reason: EndReason, opts: { onlyActive?: boolean } = {}): Promise<boolean> {
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    if (actorId) fail(checkEnd(s, actorId))
    else if (s.state === 'ENDED') return null
    if (opts.onlyActive && s.state !== 'ACTIVE') return null
    await tx.linkSession.update({ where: { id: sessionId }, data: { state: 'ENDED', endedAt: new Date(), endReason: reason } })
    await audit({ actorId, action: 'link.end', targetType: 'link_session', targetId: sessionId, payload: { reason, from: s.state } }, tx)
    return s.seats.map((x) => x.userId)
  })
  if (!userIds) return false
  notify(userIds, sessionId)
  return true
}

/**
 * At server start: end every link the relay was carrying. Its state lives in the
 * process, so after a restart no page is joined any more and nothing would ever
 * end them (cables and rooms would stay "already linked"). Lockstep lobbies don't
 * need the relay yet and survive.
 */
export async function endOrphanedLinks(): Promise<number> {
  const orphans = await prisma.linkSession.findMany({
    where: { OR: [{ state: 'ACTIVE' }, { state: 'LOBBY', mode: { in: ['CABLE', 'WIRELESS'] } }] },
    select: { id: true },
  })
  for (const s of orphans) await endSession(null, s.id, 'disconnected')
  return orphans.length
}

/** Close lobbies nobody started (worker sweeper). */
export async function expireLobbies(now = new Date()): Promise<number> {
  const stale = await prisma.linkSession.findMany({
    where: { state: 'LOBBY', createdAt: { lt: new Date(now.getTime() - LOBBY_TTL_MS) } },
    select: { id: true },
  })
  for (const s of stale) await endSession(null, s.id, 'expired')
  return stale.length
}

export interface SeatView {
  seat: number
  username: string
  mine: boolean
  slot: { id: string; gameCode: string; gameName: string; trainerName: string | null } | null
  romSha1: string | null
  ready: boolean
  /** Left a wireless room (FR-35). */
  left: boolean
  hasSave: boolean
}

/** What the lobby and every browser in the session need. Participants only. */
export async function sessionView(me: User, sessionId: string) {
  const s = await prisma.linkSession.findUnique({
    where: { id: sessionId },
    include: { host: { select: { username: true } }, seats: { orderBy: { seat: 'asc' }, include: { user: { select: { username: true } }, slot: true } } },
  })
  if (!s || !s.seats.some((x) => x.userId === me.id)) throw new HttpError(404, 'not_found', 'Link session not found.')
  return {
    id: s.id,
    mode: s.mode,
    state: s.state,
    host: s.host.username,
    isHost: s.hostId === me.id,
    rtcEpochMs: s.rtcEpochMs === null ? null : Number(s.rtcEpochMs),
    inputDelay: s.inputDelay,
    coreBuild: s.coreBuild,
    endReason: s.endReason,
    seats: s.seats.map(
      (x): SeatView => ({
        seat: x.seat,
        username: x.user.username,
        mine: x.userId === me.id,
        slot: x.slot && !x.slot.deletedAt
          ? { id: x.slot.id, gameCode: x.slot.gameCode, gameName: identifyGame(x.slot.platform, x.slot.gameCode)?.name ?? x.slot.gameCode, trainerName: x.slot.trainerName }
          : null,
        romSha1: x.romSha1,
        ready: !!x.readyAt,
        left: !!x.leftAt,
        hasSave: s.state === 'ACTIVE' ? !!x.startVersionId : false,
      }),
    ),
  }
}

/** My lobbies, running sessions and invites. */
export async function mySessions(me: User) {
  const seats = await prisma.linkSeat.findMany({
    where: { userId: me.id, session: { state: { in: ['LOBBY', 'ACTIVE'] }, mode: { not: 'CABLE' } } }, // cables live on the play page
    include: { session: { include: { host: { select: { username: true } }, _count: { select: { seats: true } } } } },
    orderBy: { createdAt: 'desc' },
  })
  const seen = new Set<string>()
  return seats.flatMap((x) => {
    if (seen.has(x.sessionId)) return []
    seen.add(x.sessionId)
    return [{ id: x.sessionId, mode: x.session.mode, state: x.session.state, host: x.session.host.username, players: x.session._count.seats, invited: !x.slotId }]
  })
}

/** The save version every browser boots seat `seat` from (null: a new game with no save yet). */
export async function seatStartSave(me: User, sessionId: string, seat: number): Promise<{ bytes: Uint8Array; versionId: string } | null> {
  const s = await prisma.linkSession.findUnique({ where: { id: sessionId }, include: { seats: true } })
  if (!s) throw new HttpError(404, 'not_found', 'Link session not found.')
  fail(checkReadSeatSave({ ...s, seats: s.seats.map((x) => ({ ...x, ready: !!x.readyAt })) }, me.id))
  const row = s.seats.find((x) => x.seat === seat)
  if (!row) throw new HttpError(404, 'not_found', 'Seat not found.')
  if (!row.startVersionId) return null
  const version = await prisma.saveVersion.findUniqueOrThrow({ where: { id: row.startVersionId } })
  return { bytes: await getSave(version.storageKey), versionId: version.id }
}

/** Is this user on this session's cable, and which seats do they play? (lib/link-relay.ts) */
export async function seatsOf(
  userId: string,
  sessionId: string,
): Promise<{ state: string; mode: LinkMode; hostId: string; seats: number[]; userIds: string[] } | null> {
  const s = await prisma.linkSession.findUnique({ where: { id: sessionId }, include: { seats: { select: { seat: true, userId: true, readyAt: true, leftAt: true } } } })
  // In a wireless room only members who joined and haven't left are on the air.
  const mine = s?.seats.filter((x) => x.userId === userId && (s.mode !== 'WIRELESS' || (x.readyAt && !x.leftAt))) ?? []
  if (!s || !mine.length) return null
  return { state: s.state, mode: s.mode, hostId: s.hostId, seats: mine.map((x) => x.seat), userIds: [...new Set(s.seats.map((x) => x.userId))] }
}

/**
 * Slots that shared a running session with `slotId`, or one that ended less
 * than LINK_GRACE_MS ago: the only slots a Pokémon may arrive from in-game
 * (lib/registry.ts, link claims). Maps each to the session they shared (the newest, if several).
 */
export async function linkPartnerSlots(tx: Tx, slotId: string, now = new Date()): Promise<Map<string, { sessionId: string; userId: string; mode: LinkMode }>> {
  // Only seats that were really in (not just invited), and not gone longer than the grace period.
  const inRoom = { readyAt: { not: null }, OR: [{ leftAt: null }, { leftAt: { gt: new Date(now.getTime() - LINK_GRACE_MS) } }] }
  const rows = await tx.linkSeat.findMany({
    where: {
      slotId: { not: slotId },
      ...inRoom,
      session: {
        seats: { some: { slotId, ...inRoom } },
        OR: [{ state: 'ACTIVE' }, { state: 'ENDED', startedAt: { not: null }, endedAt: { gt: new Date(now.getTime() - LINK_GRACE_MS) } }],
      },
    },
    select: { slotId: true, userId: true, sessionId: true, session: { select: { mode: true } } },
    orderBy: { session: { createdAt: 'asc' } },
  })
  return new Map(rows.flatMap((r) => (r.slotId ? [[r.slotId, { sessionId: r.sessionId, userId: r.userId, mode: r.session.mode }] as const] : [])))
}
