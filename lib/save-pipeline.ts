import { createHash } from 'crypto'
import type { GameSlot, SaveSource, SaveVersion } from '@prisma/client'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { saveFamilyMatchesGame } from '@/lib/games'
import { HttpError } from '@/lib/http'
import { emitToUser } from '@/lib/realtime'
import type { Conflict } from '@/lib/registry'
import { applyRegistry } from '@/lib/registry-apply'
import { checkImport, checkUpload } from '@/lib/save-rules'
import { SaveServiceError, saveService, type ParsedSave } from '@/lib/save-service'
import { putSave, saveKey } from '@/lib/storage'

export interface IngestResult {
  version: SaveVersion
  created: boolean
  conflicts: Conflict[]
}

/**
 * The one way a save version comes into existence (emulator sync, import,
 * restore). Enforces, in order:
 *   1. slot rules — parent version, lock, size (ADR-006, NFR-01)
 *   2. the save parses and belongs to the slot's game (NFR-03)
 *   3. blob stored under a new content-addressed key (NFR-07)
 *   4. one transaction: compare-and-swap the slot's current version, then
 *      reconcile the Pokémon registry (FR-20)
 * Trades (phase 2) write versions in the worker's own commit transaction.
 */
export async function ingestSave(opts: {
  slot: GameSlot
  bytes: Uint8Array
  parentVersionId: string | null
  source: Extract<SaveSource, 'EMULATOR' | 'IMPORT' | 'RESTORE'>
  actorId: string
  restoredFromId?: string
}): Promise<IngestResult> {
  const { slot, bytes, parentVersionId, source, actorId } = opts

  const rejection = source === 'IMPORT' ? checkImport(slot, bytes.length) : checkUpload(slot, parentVersionId, bytes.length)
  if (rejection) throw HttpError.from(rejection)

  let parsed: ParsedSave
  try {
    parsed = await saveService.parse(bytes)
  } catch (e) {
    if (e instanceof SaveServiceError && e.status < 500) {
      throw new HttpError(422, 'unrecognised_save', "That save file couldn't be read.")
    }
    throw e
  }
  if (!saveFamilyMatchesGame(parsed.family, slot.platform, slot.gameCode)) {
    throw new HttpError(422, 'wrong_game', "That save belongs to a different game than this slot.")
  }

  const sha256 = createHash('sha256').update(bytes).digest('hex')
  if (slot.currentVersionId) {
    const current = await prisma.saveVersion.findUniqueOrThrow({ where: { id: slot.currentVersionId } })
    if (current.sha256 === sha256) return { version: current, created: false, conflicts: [] }
  }

  const storageKey = saveKey(slot.id, sha256)
  await putSave(storageKey, bytes)

  const result = await prisma.$transaction(async (tx) => {
    const parent = slot.currentVersionId
      ? await tx.saveVersion.findUniqueOrThrow({ where: { id: slot.currentVersionId } })
      : null

    const version = await tx.saveVersion.create({
      data: {
        slotId: slot.id,
        parentId: parent?.id ?? null,
        seq: (parent?.seq ?? 0) + 1,
        storageKey,
        sha256,
        size: bytes.length,
        playSeconds: parsed.playSeconds,
        source,
        restoredFromId: opts.restoredFromId,
      },
    })

    // Compare-and-swap: only move forward from the version we validated against.
    const swapped = await tx.gameSlot.updateMany({
      where: { id: slot.id, currentVersionId: slot.currentVersionId, lockedByTradeId: null, deletedAt: null },
      data: {
        currentVersionId: version.id,
        trainerName: parsed.trainer.name.trim() || slot.trainerName,
        trainerId: parsed.trainer.tid,
        secretId: parsed.trainer.sid,
      },
    })
    if (swapped.count !== 1) {
      throw new HttpError(409, 'stale_parent', 'Your save changed somewhere else. Reload to continue.')
    }

    const conflicts = await applyRegistry(tx, {
      slotId: slot.id,
      versionId: version.id,
      seen: parsed.pokemon,
      newOrigin: source === 'IMPORT' ? 'IMPORTED' : 'NATIVE',
    })

    if (source !== 'EMULATOR' || conflicts.length) {
      await audit(
        {
          actorId,
          action: source === 'IMPORT' ? 'save.import' : source === 'RESTORE' ? 'save.restore' : 'save.upload',
          targetType: 'slot',
          targetId: slot.id,
          payload: { versionId: version.id, restoredFromId: opts.restoredFromId ?? null, conflicts: conflicts.length },
        },
        tx,
      )
    }

    return { version, created: true, conflicts }
  })

  // Other tabs on this slot are now stale; tell them before they try to sync.
  emitToUser(slot.userId, 'slot:updated', { slotId: slot.id, versionId: result.version.id, source })
  return result
}
