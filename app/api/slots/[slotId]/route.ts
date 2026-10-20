import { NextResponse } from 'next/server'
import { z } from 'zod'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { identifyGame } from '@/lib/games'
import { HttpError, route } from '@/lib/http'
import { requireUser } from '@/lib/session'
import { loadOwnSlot } from '@/lib/slots'

type Ctx = { params: Promise<{ slotId: string }> }

/** Slot detail + version history (FR-09), with which versions can be restored (ADR-007). */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const slot = await loadOwnSlot(user.id, (await params).slotId)
  const [versions, lastTrade] = await Promise.all([
    prisma.saveVersion.findMany({
      where: { slotId: slot.id },
      orderBy: { seq: 'desc' },
      select: { id: true, seq: true, source: true, playSeconds: true, createdAt: true, size: true },
    }),
    slot.lastTradeVersionId ? prisma.saveVersion.findUnique({ where: { id: slot.lastTradeVersionId } }) : null,
  ])
  const barrier = lastTrade?.seq ?? null
  return NextResponse.json({
    slot: { ...slot, game: identifyGame(slot.gameCode) },
    versions: versions.map((v) => ({
      ...v,
      current: v.id === slot.currentVersionId,
      restorable: v.id !== slot.currentVersionId && (barrier === null || v.seq >= barrier),
    })),
  })
})

const deleteBody = z.object({ confirmTrainerName: z.string() })

/** FR-10: soft delete; its Pokémon are released from the registry. */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const slot = await loadOwnSlot(user.id, (await params).slotId)
  const parsed = deleteBody.safeParse(await req.json())
  if (!parsed.success || parsed.data.confirmTrainerName !== (slot.trainerName ?? ''))
    throw new HttpError(400, 'confirm', 'Type the trainer name exactly to delete this slot.')
  if (slot.lockedByTradeId) throw new HttpError(423, 'slot_locked', 'This save is locked while a trade finishes.')

  await prisma.$transaction(async (tx) => {
    const done = await tx.gameSlot.updateMany({
      where: { id: slot.id, lockedByTradeId: null, deletedAt: null },
      data: { deletedAt: new Date() },
    })
    if (done.count !== 1) throw new HttpError(409, 'conflict')
    await tx.pokemonRegistry.updateMany({ where: { currentSlotId: slot.id }, data: { currentSlotId: null } })
    await audit({ actorId: user.id, action: 'slot.delete', targetType: 'slot', targetId: slot.id }, tx)
  })
  return new NextResponse(null, { status: 204 })
})
