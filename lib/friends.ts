import type { Prisma, User } from '@prisma/client'
import { prisma } from '@/lib/db'
import { normaliseFriendCode } from '@/lib/friend-code'
import { checkAccept, checkFriendRequest, type Between, type FriendParty } from '@/lib/friend-rules'
import { HttpError } from '@/lib/http'
import { emitToUser } from '@/lib/realtime'

type Tx = Prisma.TransactionClient

/**
 * Friends and blocks (FR-03). Rules live in lib/friend-rules.ts; this file
 * loads the state they need and applies the outcome in one transaction.
 */

/** A player by username or friend code (dashes optional). */
export async function findPlayer(query: string): Promise<User> {
  const code = normaliseFriendCode(query)
  const user = code
    ? await prisma.user.findUnique({ where: { friendCode: code } })
    : await prisma.user.findUnique({ where: { username: query.trim().toLowerCase() } })
  if (!user) throw new HttpError(404, 'not_found', 'No player with that username or friend code.')
  return user
}

/** Either side blocks the other. Trades (phase 2) must check this too. */
export async function isBlockedEitherWay(a: string, b: string, tx: Tx = prisma): Promise<boolean> {
  const n = await tx.block.count({
    where: { OR: [{ blockerId: a, blockedId: b }, { blockerId: b, blockedId: a }] },
  })
  return n > 0
}

function pairWhere(a: string, b: string): Prisma.FriendshipWhereInput {
  return { OR: [{ requesterId: a, addresseeId: b }, { requesterId: b, addresseeId: a }] }
}

async function between(tx: Tx, a: string, b: string): Promise<Between & { friendshipId: string | null }> {
  const [friendship, blocked] = await Promise.all([
    tx.friendship.findFirst({ where: pairWhere(a, b) }),
    isBlockedEitherWay(a, b, tx),
  ])
  return { friendship, friendshipId: friendship?.id ?? null, blocked }
}

async function party(tx: Tx, userId: string): Promise<FriendParty> {
  const [user, friendCount] = await Promise.all([
    tx.user.findUniqueOrThrow({ where: { id: userId }, select: { emailVerifiedAt: true } }),
    tx.friendship.count({ where: { status: 'ACCEPTED', OR: [{ requesterId: userId }, { addresseeId: userId }] } }),
  ])
  return { id: userId, emailVerified: !!user.emailVerifiedAt, friendCount }
}

/**
 * Lock both users' rows (in id order, so two transactions can't deadlock) so
 * concurrent accepts can't push anyone past MAX_FRIENDS.
 */
async function lockPair(tx: Tx, a: string, b: string): Promise<void> {
  const ids = [a, b].sort()
  await tx.$queryRaw`SELECT id FROM users WHERE id IN (${ids[0]}, ${ids[1]}) ORDER BY id FOR UPDATE`
}

function notify(...userIds: string[]) {
  for (const id of userIds) emitToUser(id, 'friends:updated', {})
}

/** Send a request; if they already asked me, this accepts theirs. */
export async function sendFriendRequest(me: User, them: User): Promise<'requested' | 'accepted'> {
  const outcome = await prisma.$transaction(async (tx) => {
    if (me.id !== them.id) await lockPair(tx, me.id, them.id)
    const [mine, theirs, b] = await Promise.all([party(tx, me.id), party(tx, them.id), between(tx, me.id, them.id)])
    const verdict = checkFriendRequest(mine, theirs, b)
    if (verdict.action === 'reject') throw HttpError.from(verdict.rejection)
    if (verdict.action === 'accept') {
      await tx.friendship.update({ where: { id: b.friendshipId! }, data: { status: 'ACCEPTED', acceptedAt: new Date() } })
      return 'accepted' as const
    }
    await tx.friendship.create({ data: { requesterId: me.id, addresseeId: them.id } })
    return 'requested' as const
  })
  notify(me.id, them.id)
  return outcome
}

/** Accept a request sent to me. */
export async function acceptFriendRequest(me: User, friendshipId: string): Promise<void> {
  const row = await prisma.friendship.findFirst({ where: { id: friendshipId, addresseeId: me.id } })
  if (!row) throw new HttpError(404, 'not_found', 'Friend request not found.')
  await prisma.$transaction(async (tx) => {
    await lockPair(tx, me.id, row.requesterId)
    const [mine, theirs, b] = await Promise.all([
      party(tx, me.id),
      party(tx, row.requesterId),
      between(tx, me.id, row.requesterId),
    ])
    const rejection = checkAccept(mine, theirs, b)
    if (rejection) throw HttpError.from(rejection)
    await tx.friendship.update({ where: { id: row.id }, data: { status: 'ACCEPTED', acceptedAt: new Date() } })
  })
  notify(me.id, row.requesterId)
}

/** Decline a request to me, cancel mine, or remove a friend — all the same delete. */
export async function removeFriendship(me: User, friendshipId: string): Promise<void> {
  const row = await prisma.friendship.findFirst({
    where: { id: friendshipId, OR: [{ requesterId: me.id }, { addresseeId: me.id }] },
  })
  if (!row) throw new HttpError(404, 'not_found', 'Not found.')
  await prisma.friendship.deleteMany({ where: { id: row.id } })
  notify(row.requesterId, row.addresseeId)
}

/** Block: ends any friendship or pending request between us, both ways. Allowed without a verified email. */
export async function blockPlayer(me: User, them: User): Promise<void> {
  if (me.id === them.id) throw new HttpError(400, 'self', "You can't block yourself.")
  await prisma.$transaction(async (tx) => {
    await tx.block.upsert({
      where: { blockerId_blockedId: { blockerId: me.id, blockedId: them.id } },
      create: { blockerId: me.id, blockedId: them.id },
      update: {},
    })
    await tx.friendship.deleteMany({ where: pairWhere(me.id, them.id) })
  })
  notify(me.id, them.id)
}

export async function unblockPlayer(me: User, blockedId: string): Promise<void> {
  await prisma.block.deleteMany({ where: { blockerId: me.id, blockedId } })
  notify(me.id)
}

const PUBLIC = { id: true, username: true } as const

/** My friend list, requests both ways, and who I block. Never shows anyone's email or friend code. */
export async function listFriends(me: User) {
  const [rows, blocks] = await Promise.all([
    prisma.friendship.findMany({
      where: { OR: [{ requesterId: me.id }, { addresseeId: me.id }] },
      include: { requester: { select: PUBLIC }, addressee: { select: PUBLIC } },
      orderBy: { createdAt: 'desc' },
    }),
    prisma.block.findMany({ where: { blockerId: me.id }, include: { blocked: { select: PUBLIC } }, orderBy: { createdAt: 'desc' } }),
  ])
  const other = (r: (typeof rows)[number]) => (r.requesterId === me.id ? r.addressee : r.requester)
  return {
    friends: rows
      .filter((r) => r.status === 'ACCEPTED')
      .map((r) => ({ friendshipId: r.id, user: other(r), since: r.acceptedAt }))
      .sort((a, b) => a.user.username.localeCompare(b.user.username)),
    incoming: rows
      .filter((r) => r.status === 'PENDING' && r.addresseeId === me.id)
      .map((r) => ({ friendshipId: r.id, user: r.requester, sentAt: r.createdAt })),
    outgoing: rows
      .filter((r) => r.status === 'PENDING' && r.requesterId === me.id)
      .map((r) => ({ friendshipId: r.id, user: r.addressee, sentAt: r.createdAt })),
    blocked: blocks.map((b) => ({ user: b.blocked, since: b.createdAt })),
  }
}
