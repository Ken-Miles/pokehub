import { notFound, redirect } from 'next/navigation'
import { Player } from '@/components/Player'
import { prisma } from '@/lib/db'
import { identifyGame } from '@/lib/games'
import { currentUser } from '@/lib/session'

export default async function PlayPage({ params }: { params: Promise<{ slotId: string }> }) {
  const user = await currentUser()
  if (!user) redirect('/login')
  const slot = await prisma.gameSlot.findFirst({ where: { id: (await params).slotId, userId: user.id, deletedAt: null } })
  if (!slot) notFound()
  const game = identifyGame(slot.gameCode)!
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-semibold">
        {game.name} <span className="text-muted">· {slot.trainerName ?? 'New game'}</span>
      </h1>
      <Player
        slotId={slot.id}
        gameCode={slot.gameCode}
        gameName={game.name}
        emulatorData={process.env.NEXT_PUBLIC_EMULATORJS_DATA ?? '/emulator/data/'}
      />
    </div>
  )
}
