import type { Prisma, User } from '@prisma/client'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { isBlockedEitherWay } from '@/lib/friends'
import { identifyGame } from '@/lib/games'
import { HttpError } from '@/lib/http'
import { checkAcceptCable, checkCable, type SlotForSeat } from '@/lib/link-rules'
import { endSession, lockState, notify, slotForSeat } from '@/lib/link-sessions'
import { emitToUser, playingSlots } from '@/lib/realtime'
import type { Rejection } from '@/lib/save-rules'

type Tx = Prisma.TransactionClient

/**
 * The link cable on the play page (FR-34): two friends, each in their own running
 * game, plug a cable between them. A cable is a two-seat CABLE session whose
 * messages travel over lib/link-relay.ts: bytes for Game Boy (ADR-020), words for
 * Gen 3 (ADR-021; the requester is seat 0, the cable's parent). In-game trades are
 * reconciled like any other link trade (lib/registry.ts, lib/save-pipeline.ts).
 * Unplugging is DELETE /api/link/:id.
 */

const fail = (r: Rejection | null) => {
  if (r) throw HttpError.from(r)
}

/** The slot a user's newest open play page is running, if any. */
export async function playingSlot(tx: Tx, userId: string): Promise<SlotForSeat | null> {
  const id = playingSlots(userId).at(-1)
  return id ? slotForSeat(tx, id, null).catch(() => null) : null
}

export async function friendship(tx: Tx, a: string, b: string) {
  const [row, blocked] = await Promise.all([
    tx.friendship.findFirst({ where: { status: 'ACCEPTED', OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] } }),
    isBlockedEitherWay(a, b, tx),
  ])
  return { id: b, friends: !!row, blocked }
}

/**
 * Friends playing a game my cable fits right now (or, given `check`, one my wireless
 * room could invite). `busy`: already linked to someone.
 */
export async function onlineFriends(me: User, slotId: string, check = checkCable) {
  const mine = await slotForSeat(prisma, slotId, null)
  const rows = await prisma.friendship.findMany({
    where: { status: 'ACCEPTED', OR: [{ requesterId: me.id }, { addresseeId: me.id }] },
    include: { requester: { select: { id: true, username: true } }, addressee: { select: { id: true, username: true } } },
  })
  const out = []
  for (const row of rows) {
    const friend = row.requesterId === me.id ? row.addressee : row.requester
    const theirs = await playingSlot(prisma, friend.id)
    if (!theirs) continue
    const problem = check(me.id, mine, await friendship(prisma, me.id, friend.id), theirs)
    if (problem && problem.code !== 'slot_busy') continue
    out.push({ userId: friend.id, username: friend.username, game: identifyGame(theirs.platform, theirs.gameCode)?.name ?? theirs.gameCode, busy: !!problem })
  }
  return out
}

/** Ask a friend to plug in. A newer request replaces any unanswered one for either game. */
export async function requestCable(me: User, slotId: string, friendId: string): Promise<string> {
  const stale = await prisma.linkSession.findMany({
    where: { mode: 'CABLE', state: 'LOBBY', seats: { some: { userId: { in: [me.id, friendId] } } } },
    select: { id: true },
  })
  for (const s of stale) await endSession(null, s.id, 'expired')

  const { id, theirSlotId } = await prisma.$transaction(async (tx) => {
    const mine = await slotForSeat(tx, slotId, null)
    const theirs = await playingSlot(tx, friendId)
    fail(checkCable(me.id, mine, await friendship(tx, me.id, friendId), theirs))
    const s = await tx.linkSession.create({
      data: { hostId: me.id, mode: 'CABLE', seats: { create: [{ seat: 0, userId: me.id, slotId }, { seat: 1, userId: friendId, slotId: theirs!.id }] } },
    })
    await audit({ actorId: me.id, action: 'link.create', targetType: 'link_session', targetId: s.id, payload: { mode: 'CABLE', slotId, with: friendId } }, tx)
    return { id: s.id, theirSlotId: theirs!.id }
  })
  emitToUser(friendId, 'cable:request', { sessionId: id, from: me.username, slotId: theirSlotId })
  return id
}

/** The friend plugs the cable in: both seats pin their current save, and the session runs. */
export async function acceptCable(me: User, sessionId: string): Promise<void> {
  const userIds = await prisma.$transaction(async (tx) => {
    const s = await lockState(tx, sessionId)
    fail(checkAcceptCable(s, me.id))
    for (const seat of s.seats) {
      const slot = await tx.gameSlot.findUniqueOrThrow({ where: { id: seat.slotId! } })
      if (slot.deletedAt || slot.lockedByTradeId) throw new HttpError(409, 'slot_busy', 'One of the games is no longer available.')
      await tx.linkSeat.update({ where: { sessionId_seat: { sessionId, seat: seat.seat } }, data: { startVersionId: slot.currentVersionId, readyAt: new Date() } })
    }
    await tx.linkSession.update({ where: { id: sessionId }, data: { state: 'ACTIVE', startedAt: new Date() } })
    await audit({ actorId: me.id, action: 'link.start', targetType: 'link_session', targetId: sessionId, payload: { mode: 'CABLE', seats: s.seats.map((x) => x.slotId) } }, tx)
    return s.seats.map((x) => x.userId)
  })
  notify(userIds, sessionId, 'cable:plugged')
}
