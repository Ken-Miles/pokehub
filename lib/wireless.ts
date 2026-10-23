import type { User } from '@prisma/client'
import { audit } from '@/lib/audit'
import { friendship, onlineFriends, playingSlot } from '@/lib/cable'
import { prisma } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { MAX_ROOM, checkAirFriend, checkJoinRoom, checkLeaveRoom, checkOpenRoom, checkRoomInvite } from '@/lib/link-rules'
import { endSession, lockState, notify, slotForSeat } from '@/lib/link-sessions'
import { emitToLinkRoom, emitToUser } from '@/lib/realtime'
import type { Rejection } from '@/lib/save-rules'

/**
 * Wireless Adapter rooms (FR-35, ADR-022): friends playing FireRed, LeafGreen or
 * Emerald turn their adapters on in one room (2–5 players), and only adapters in
 * the same room see each other. A room is a WIRELESS link session that runs from
 * the start; members join and leave while it runs (seat.leftAt), the host closes
 * it. In-game trades are reconciled like any other link trade. Adapter messages
 * travel over lib/link-relay.ts.
 */

const fail = (r: Rejection | null) => {
  if (r) throw HttpError.from(r)
}

/** Air ops the emulator understands (public/emulator/player.js): 2 beacon off, 7 leave. */
const AIR_BEACON_OFF = 2
const AIR_LEAVE = 7

export async function openRoom(me: User, slotId: string): Promise<string> {
  return prisma.$transaction(async (tx) => {
    const mine = await slotForSeat(tx, slotId, null)
    fail(checkOpenRoom(me.id, mine))
    const now = new Date()
    const s = await tx.linkSession.create({
      data: {
        hostId: me.id,
        mode: 'WIRELESS',
        state: 'ACTIVE',
        startedAt: now,
        seats: { create: { seat: 0, userId: me.id, slotId, readyAt: now, startVersionId: mine.currentVersionId } },
      },
    })
    await audit({ actorId: me.id, action: 'link.create', targetType: 'link_session', targetId: s.id, payload: { mode: 'WIRELESS', slotId } }, tx)
    return s.id
  })
}

/** Online friends my room could invite, judged against my running game. */
export function roomFriends(me: User, slotId: string) {
  return onlineFriends(me, slotId, (meId, mine, friend, theirs) => checkAirFriend(meId, { ...mine, otherOpenSessions: 0 }, friend, theirs))
}

/** Invite a friend who's playing now: they get a seat (not yet in) and an Accept prompt. */
export async function inviteToRoom(me: User, sessionId: string, friendId: string): Promise<void> {
  const { theirSlotId, userIds } = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    const myRow = s.seats.find((x) => x.userId === me.id && x.ready && !x.left)
    const mine = myRow?.slotId ? await slotForSeat(tx, myRow.slotId, sessionId) : null
    if (!mine) throw new HttpError(404, 'not_found', 'Room not found.')
    const theirs = await playingSlot(tx, friendId)
    fail(checkRoomInvite(s, me.id, mine, await friendship(tx, me.id, friendId), theirs))
    // A seat number is the adapter's ID in the room: reuse a seat someone left, or take the next free one.
    const reuse = s.seats.find((x) => x.slotId === theirs!.id) ?? s.seats.find((x) => x.left)
    const seat = reuse?.seat ?? [...Array(MAX_ROOM).keys()].find((n) => !s.seats.some((x) => x.seat === n))!
    const data = { userId: friendId, slotId: theirs!.id, readyAt: null, leftAt: null, startVersionId: null }
    if (reuse) await tx.linkSeat.update({ where: { sessionId_seat: { sessionId, seat } }, data })
    else await tx.linkSeat.create({ data: { sessionId, seat, ...data } })
    return { theirSlotId: theirs!.id, userIds: s.seats.map((x) => x.userId) }
  })
  notify(userIds, sessionId)
  emitToUser(friendId, 'air:invite', { sessionId, from: me.username, slotId: theirSlotId })
}

/** The invited friend's adapter joins: their seat pins its current save. */
export async function joinRoom(me: User, sessionId: string): Promise<void> {
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    fail(checkJoinRoom(s, me.id))
    const row = s.seats.find((x) => x.userId === me.id && !x.left)!
    const slot = await tx.gameSlot.findUniqueOrThrow({ where: { id: row.slotId! } })
    if (slot.deletedAt || slot.lockedByTradeId) throw new HttpError(409, 'slot_busy', 'Your game is no longer available.')
    await tx.linkSeat.update({ where: { sessionId_seat: { sessionId, seat: row.seat } }, data: { readyAt: new Date(), startVersionId: slot.currentVersionId } })
    await audit({ actorId: me.id, action: 'link.join', targetType: 'link_session', targetId: sessionId, payload: { seat: row.seat, slotId: slot.id } }, tx)
    return s.seats.map((x) => x.userId)
  })
  notify(userIds, sessionId)
}

/**
 * Leave a room (or decline an invite). The others' adapters are told this seat's
 * beacon is gone and it disconnected, so their games show "link lost" instead of
 * waiting. The host closes the room instead (DELETE /api/link/:id); a host whose
 * page drops closes it too (lib/link-relay.ts).
 */
export async function leaveRoom(userId: string, sessionId: string, reason: 'left' | 'disconnected'): Promise<void> {
  const left = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    fail(checkLeaveRoom(s, userId))
    const row = s.seats.find((x) => x.userId === userId && !x.left)!
    if (row.ready) await tx.linkSeat.update({ where: { sessionId_seat: { sessionId, seat: row.seat } }, data: { leftAt: new Date() } })
    else await tx.linkSeat.delete({ where: { sessionId_seat: { sessionId, seat: row.seat } } }) // declined
    await audit({ actorId: userId, action: 'link.leave', targetType: 'link_session', targetId: sessionId, payload: { seat: row.seat, reason, joined: row.ready } }, tx)
    return { seat: row.seat, joined: row.ready, userIds: s.seats.map((x) => x.userId) }
  })
  if (left.joined) for (const op of [AIR_BEACON_OFF, AIR_LEAVE]) emitToLinkRoom(sessionId, 'link:msg', { t: 'a', p: left.seat, op, d: [] })
  notify(left.userIds, sessionId)
}

/** Close my room for everyone (host). */
export async function closeRoom(me: User, sessionId: string): Promise<void> {
  await endSession(me.id, sessionId, 'ended')
}
