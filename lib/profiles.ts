import { prisma } from '@/lib/db'
import { identifyGame } from '@/lib/games'

/**
 * The public profile (FR-02). Built from an explicit field list so email,
 * friend code, trainer IDs and save contents can never leak into it by
 * accident — tests/integration/profiles.itest.ts checks the shape.
 */
export interface PublicProfile {
  username: string
  joinedAt: Date
  games: { slotNumber: number; game: string; region: string | null; trainerName: string | null }[]
  completedTrades: number
}

/** Null when there's no such player, or they are banned. */
export async function publicProfile(username: string): Promise<PublicProfile | null> {
  const user = await prisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: {
      id: true,
      username: true,
      status: true,
      createdAt: true,
      slots: {
        where: { deletedAt: null },
        orderBy: { slotNumber: 'asc' },
        select: { slotNumber: true, platform: true, gameCode: true, trainerName: true },
      },
    },
  })
  if (!user || user.status === 'BANNED') return null

  // Trades on deleted slots still happened, so they still count.
  const completedTrades = await prisma.trade.count({
    where: { state: 'COMPLETED', OR: [{ aSlot: { userId: user.id } }, { bSlot: { userId: user.id } }] },
  })

  return {
    username: user.username,
    joinedAt: user.createdAt,
    games: user.slots.map((s) => {
      const game = identifyGame(s.platform, s.gameCode)
      return { slotNumber: s.slotNumber, game: game?.name ?? s.gameCode, region: game?.region ?? null, trainerName: s.trainerName }
    }),
    completedTrades,
  }
}
