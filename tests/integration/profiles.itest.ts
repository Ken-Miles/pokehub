import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { publicProfile } from '@/lib/profiles'

/** FR-02: what a public profile shows, and what it must never show. */
const run = Date.now().toString(36)
let n = 0

async function player(over: { status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' } = {}) {
  const tag = `${run}_${n++}`
  return prisma.user.create({
    data: {
      username: `it_${tag}`,
      email: `it-${tag}@example.test`,
      passwordHash: 'x',
      friendCode: newFriendCode(),
      statusReason: over.status ? 'secret moderator note' : null,
      ...over,
    },
  })
}

const slot = (userId: string, slotNumber: number, over: object = {}) =>
  prisma.gameSlot.create({
    data: {
      userId,
      slotNumber,
      platform: 'GBA',
      gameCode: 'BPEE',
      language: 'E',
      origin: 'NEW',
      trainerName: 'MAY',
      trainerId: 12345,
      secretId: 54321,
      ...over,
    },
  })

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, trades, pokemon_registry, audit_events CASCADE')
})
afterAll(() => prisma.$disconnect())

describe('publicProfile', () => {
  it('shows username, join date, and each live game with its trainer name', async () => {
    const u = await player()
    await slot(u.id, 1)
    await slot(u.id, 2, { gameCode: 'AXVE', trainerName: null })
    await slot(u.id, 3, { gameCode: 'BPRE', deletedAt: new Date() })

    const p = await publicProfile(u.username.toUpperCase())
    expect(p).toEqual({
      username: u.username,
      joinedAt: u.createdAt,
      games: [
        { slotNumber: 1, game: 'Emerald', region: expect.any(String), trainerName: 'MAY' },
        { slotNumber: 2, game: 'Ruby', region: expect.any(String), trainerName: null },
      ],
      completedTrades: 0,
    })
  })

  it('never contains email, friend code, ids, trainer IDs or status notes', async () => {
    const u = await player({ status: 'SUSPENDED' })
    await slot(u.id, 1)
    const json = JSON.stringify(await publicProfile(u.username))
    for (const secret of [u.email, u.friendCode, u.id, '12345', '54321', 'secret moderator note', 'SUSPENDED']) {
      expect(json).not.toContain(secret)
    }
  })

  it('counts only completed trades, including ones on deleted slots', async () => {
    const [a, b] = [await player(), await player()]
    const [sa, sb] = [await slot(a.id, 1, { deletedAt: new Date() }), await slot(b.id, 1)]
    const trade = (state: 'COMPLETED' | 'FAILED' | 'OPEN') =>
      prisma.trade.create({ data: { state, aSlotId: sa.id, bSlotId: sb.id, expiresAt: new Date() } })
    await trade('COMPLETED')
    await trade('COMPLETED')
    await trade('FAILED')
    await trade('OPEN')
    expect((await publicProfile(a.username))?.completedTrades).toBe(2)
    expect((await publicProfile(b.username))?.completedTrades).toBe(2)
  })

  it('hides banned players and unknown names', async () => {
    const banned = await player({ status: 'BANNED' })
    expect(await publicProfile(banned.username)).toBeNull()
    expect(await publicProfile('no_such_player')).toBeNull()
  })
})
