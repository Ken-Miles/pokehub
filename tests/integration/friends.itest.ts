import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { MAX_FRIENDS } from '@/lib/friend-rules'
import {
  acceptFriendRequest,
  blockPlayer,
  findPlayer,
  isBlockedEitherWay,
  listFriends,
  removeFriendship,
  sendFriendRequest,
  unblockPlayer,
} from '@/lib/friends'
import { HttpError } from '@/lib/http'

/** FR-03 against real Postgres: requests, accept, remove, block, the cap and the pair index. */
const run = Date.now().toString(36)
let n = 0

async function player(verified = true) {
  const tag = `${run}_${n++}`
  return prisma.user.create({
    data: {
      username: `it_${tag}`,
      email: `it-${tag}@example.test`,
      passwordHash: 'x',
      friendCode: newFriendCode(),
      emailVerifiedAt: verified ? new Date() : null,
    },
  })
}

async function code(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (e instanceof HttpError) return e.code
    throw e
  }
  return 'ok'
}

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, pokemon_registry, audit_events CASCADE')
})
afterAll(() => prisma.$disconnect())

describe('friend requests', () => {
  it('finds players by username or friend code, with or without dashes', async () => {
    const a = await player()
    expect((await findPlayer(a.username.toUpperCase())).id).toBe(a.id)
    expect((await findPlayer(a.friendCode)).id).toBe(a.id)
    expect((await findPlayer(a.friendCode.replace(/-/g, ''))).id).toBe(a.id)
    expect(await code(findPlayer('nobody_here'))).toBe('not_found')
  })

  it('request → accept → friends on both sides → remove', async () => {
    const [a, b] = [await player(), await player()]
    expect(await sendFriendRequest(a, b)).toBe('requested')
    const { incoming } = await listFriends(b)
    expect(incoming.map((r) => r.user.username)).toEqual([a.username])
    expect(await code(acceptFriendRequest(a, incoming[0].friendshipId))).toBe('not_found') // not mine to accept

    await acceptFriendRequest(b, incoming[0].friendshipId)
    expect((await listFriends(a)).friends.map((f) => f.user.username)).toEqual([b.username])
    expect((await listFriends(b)).friends.map((f) => f.user.username)).toEqual([a.username])

    await removeFriendship(a, incoming[0].friendshipId)
    expect((await listFriends(b)).friends).toEqual([])
  })

  it('asking someone who already asked you makes you friends', async () => {
    const [a, b] = [await player(), await player()]
    await sendFriendRequest(a, b)
    expect(await sendFriendRequest(b, a)).toBe('accepted')
    expect(await prisma.friendship.count()).toBe(1)
  })

  it('never stores two rows for one pair, even written directly', async () => {
    const [a, b] = [await player(), await player()]
    await prisma.friendship.create({ data: { requesterId: a.id, addresseeId: b.id } })
    await expect(prisma.friendship.create({ data: { requesterId: b.id, addresseeId: a.id } })).rejects.toThrow()
  })

  it('needs a verified email to send or accept, but not to decline', async () => {
    const [a, u] = [await player(), await player(false)]
    expect(await code(sendFriendRequest(u, a))).toBe('email_unverified')
    await sendFriendRequest(a, u)
    const [req] = (await listFriends(u)).incoming
    expect(await code(acceptFriendRequest(u, req.friendshipId))).toBe('email_unverified')
    expect(await code(removeFriendship(u, req.friendshipId))).toBe('ok')
  })

  it(`stops at ${MAX_FRIENDS} friends`, async () => {
    const a = await player()
    const others = await Promise.all(Array.from({ length: MAX_FRIENDS }, () => player()))
    await prisma.friendship.createMany({
      data: others.map((o) => ({ requesterId: a.id, addresseeId: o.id, status: 'ACCEPTED' as const, acceptedAt: new Date() })),
    })
    const extra = await player()
    expect(await code(sendFriendRequest(extra, a))).toBe('friends_full_other')
    expect(await code(sendFriendRequest(a, extra))).toBe('friends_full')
  })

  it('concurrent accepts cannot pass the cap', async () => {
    const a = await player()
    const others = await Promise.all(Array.from({ length: MAX_FRIENDS - 1 }, () => player()))
    await prisma.friendship.createMany({
      data: others.map((o) => ({ requesterId: a.id, addresseeId: o.id, status: 'ACCEPTED' as const, acceptedAt: new Date() })),
    })
    const [x, y] = [await player(), await player()]
    await sendFriendRequest(x, a)
    await sendFriendRequest(y, a)
    const ids = (await listFriends(a)).incoming.map((r) => r.friendshipId)
    const results = await Promise.all(ids.map((id) => code(acceptFriendRequest(a, id))))
    expect(results.sort()).toEqual(['friends_full', 'ok'])
    expect((await listFriends(a)).friends).toHaveLength(MAX_FRIENDS)
  })
})

describe('blocks', () => {
  it('ends the friendship and stops requests both ways', async () => {
    const [a, b] = [await player(), await player()]
    await sendFriendRequest(a, b)
    await sendFriendRequest(b, a) // friends
    await blockPlayer(a, b)

    expect((await listFriends(a)).friends).toEqual([])
    expect((await listFriends(a)).blocked.map((x) => x.user.username)).toEqual([b.username])
    expect(await isBlockedEitherWay(b.id, a.id)).toBe(true)
    expect(await code(sendFriendRequest(b, a))).toBe('unavailable')
    expect(await code(sendFriendRequest(a, b))).toBe('unavailable')
  })

  it('hides a pending request from the blocked player', async () => {
    const [a, b] = [await player(), await player()]
    await sendFriendRequest(b, a)
    await blockPlayer(a, b)
    expect((await listFriends(a)).incoming).toEqual([])
    expect((await listFriends(b)).outgoing).toEqual([])
  })

  it('works without a verified email, and unblocking lets requests through again', async () => {
    const [u, b] = [await player(false), await player()]
    await blockPlayer(u, b)
    expect(await code(sendFriendRequest(b, u))).toBe('unavailable')
    await unblockPlayer(u, b.id)
    expect(await sendFriendRequest(b, u)).toBe('requested')
  })
})
