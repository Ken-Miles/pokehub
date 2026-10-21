import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { logger } from '@/lib/logger'
import { SLOT_RECOVERY_DAYS } from '@/lib/save-rules'
import { deletePurgedSave } from '@/lib/storage'

const BATCH = 50

/**
 * FR-10 / ADR-017: a deleted slot can be recovered for 30 days; after that it
 * is purged — the slot, its save versions, sightings and flags, then its blobs
 * (NFR-12: saves go when the player deletes them). Run by the worker.
 *
 * Database first, in one transaction that re-checks the slot is still deleted
 * and old enough (so a recovery racing the purge wins). Blobs after: a failed
 * blob delete leaves an unreferenced object, never a row pointing at nothing.
 * Slots that appear in a trade are skipped until Phase 2 decides how trade
 * history outlives a slot.
 */
export async function purgeDeletedSlots(now = new Date()): Promise<{ purged: number; skipped: number; blobErrors: number }> {
  const cutoff = new Date(now.getTime() - SLOT_RECOVERY_DAYS * 24 * 3600 * 1000)
  const due = await prisma.gameSlot.findMany({
    where: { deletedAt: { lt: cutoff } },
    select: { id: true, userId: true, _count: { select: { tradesA: true, tradesB: true } } },
    orderBy: { deletedAt: 'asc' },
    take: BATCH,
  })

  let purged = 0
  let skipped = 0
  let blobErrors = 0
  for (const slot of due) {
    if (slot._count.tradesA || slot._count.tradesB) {
      skipped++
      continue
    }
    const keys = await prisma.$transaction(async (tx) => {
      const versions = await tx.saveVersion.findMany({ where: { slotId: slot.id }, select: { storageKey: true } })
      const gone = await tx.gameSlot.deleteMany({ where: { id: slot.id, deletedAt: { lt: cutoff } } })
      if (gone.count !== 1) return null // recovered (or purged) meanwhile
      await audit(
        { actorId: null, action: 'slot.purge', targetType: 'slot', targetId: slot.id, payload: { ownerId: slot.userId, versions: versions.length } },
        tx,
      )
      return versions.map((v) => v.storageKey)
    })
    if (!keys) continue
    purged++
    for (const key of new Set(keys)) {
      try {
        await deletePurgedSave(key)
      } catch (err) {
        blobErrors++
        logger.warn({ err, slotId: slot.id, key }, 'purged slot: blob delete failed')
      }
    }
  }
  return { purged, skipped, blobErrors }
}
