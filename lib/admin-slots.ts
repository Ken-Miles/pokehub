import type { User } from '@prisma/client'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { identifyGame } from '@/lib/games'
import { HttpError } from '@/lib/http'
import { applyRegistry } from '@/lib/registry-apply'
import { SLOT_RECOVERY_DAYS, checkRecover } from '@/lib/save-rules'
import { saveService, type ParsedSave } from '@/lib/save-service'
import { getSave } from '@/lib/storage'

/** A player's slots for admins, deleted ones included (FR-10). */
export async function slotsForAdmin(username: string) {
  const user = await prisma.user.findUnique({
    where: { username: username.trim().toLowerCase() },
    select: { id: true, username: true, status: true, createdAt: true },
  })
  if (!user) throw new HttpError(404, 'not_found', 'No player with that username.')
  const slots = await prisma.gameSlot.findMany({
    where: { userId: user.id },
    orderBy: [{ deletedAt: { sort: 'desc', nulls: 'first' } }, { slotNumber: 'asc' }],
    include: { currentVersion: { select: { seq: true, playSeconds: true, createdAt: true } } },
  })
  const now = Date.now()
  return {
    user,
    slots: slots.map((s) => {
      const until = s.deletedAt ? new Date(s.deletedAt.getTime() + SLOT_RECOVERY_DAYS * 24 * 3600 * 1000) : null
      return {
        id: s.id,
        slotNumber: s.slotNumber,
        game: identifyGame(s.platform, s.gameCode)?.name ?? s.gameCode,
        origin: s.origin,
        trainerName: s.trainerName,
        trainerId: s.trainerId,
        currentVersion: s.currentVersion,
        deletedAt: s.deletedAt,
        recoverableUntil: until && until.getTime() > now ? until : null,
        lockedByTradeId: s.lockedByTradeId,
      }
    }),
  }
}

/**
 * FR-10: undo a slot delete. The slot's Pokémon were released from the registry
 * when it was deleted, so its current save is reconciled again (same rules as an
 * upload): released ones are claimed back, and any that another live slot holds
 * by now are flagged as clones rather than silently taken. Audit-logged (FR-24).
 */
export async function recoverSlot(admin: User, slotId: string): Promise<{ slotNumber: number; conflicts: number }> {
  const slot = await prisma.gameSlot.findUnique({ where: { id: slotId } })
  if (!slot) throw new HttpError(404, 'not_found', 'Slot not found.')

  // Parse outside the transaction: it is a network call to the save service.
  let parsed: ParsedSave | null = null
  if (slot.currentVersionId) {
    const version = await prisma.saveVersion.findUniqueOrThrow({ where: { id: slot.currentVersionId } })
    parsed = await saveService.parse(await getSave(version.storageKey))
  }

  return prisma.$transaction(async (tx) => {
    const live = await tx.gameSlot.findMany({ where: { userId: slot.userId, deletedAt: null }, select: { slotNumber: true } })
    const verdict = checkRecover(slot, live.map((s) => s.slotNumber))
    if ('status' in verdict) throw HttpError.from(verdict)

    // Compare-and-swap on deletedAt, so two admins can't both recover it.
    const done = await tx.gameSlot.updateMany({
      where: { id: slot.id, deletedAt: slot.deletedAt },
      data: { deletedAt: null, slotNumber: verdict.slotNumber },
    })
    if (done.count !== 1) throw new HttpError(409, 'conflict', 'Someone else changed this slot first.')

    const conflicts =
      parsed && slot.currentVersionId
        ? (
            await applyRegistry(tx, {
              slotId: slot.id,
              versionId: slot.currentVersionId,
              seen: parsed.pokemon,
              newOrigin: slot.origin === 'IMPORTED' ? 'IMPORTED' : 'NATIVE',
            })
          ).conflicts
        : []

    await audit(
      {
        actorId: admin.id,
        action: 'admin.slot.recover',
        targetType: 'slot',
        targetId: slot.id,
        payload: { ownerId: slot.userId, slotNumber: verdict.slotNumber, deletedAt: slot.deletedAt!.toISOString(), conflicts: conflicts.length },
      },
      tx,
    )
    return { slotNumber: verdict.slotNumber, conflicts: conflicts.length }
  })
}
