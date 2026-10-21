import { PLATFORMS, isAcceptedSaveSize, type Platform } from '@/lib/games'

export const MAX_SLOTS = 3 // FR-10
/** FR-10: a deleted slot can be recovered by an admin for this long. */
export const SLOT_RECOVERY_DAYS = 30

/**
 * Pure rules for accepting uploads and restores. Kept free of I/O so the
 * anti-duplication invariants are unit-tested (tests/save-rules.test.ts).
 */


export interface Rejection {
  status: 400 | 403 | 404 | 409 | 413 | 422 | 423
  code: string
  message: string
}

export interface SlotState {
  id: string
  platform: Platform
  deletedAt: Date | null
  lockedByTradeId: string | null
  currentVersionId: string | null
}

/**
 * ADR-006: an upload must name the version it was built on. Anything else is a
 * stale tab or a pre-trade save state and would undo a trade.
 */
export function checkUpload(slot: SlotState, parentVersionId: string | null, size: number): Rejection | null {
  if (slot.deletedAt) return { status: 404, code: 'slot_deleted', message: 'This slot was deleted.' }
  if (!isAcceptedSaveSize(slot.platform, size)) return badSize(slot.platform)
  if (slot.lockedByTradeId)
    return { status: 423, code: 'slot_locked', message: 'This save is locked while a trade finishes.' }
  if ((slot.currentVersionId ?? null) !== (parentVersionId ?? null))
    return {
      status: 409,
      code: 'stale_parent',
      message: 'Your save changed somewhere else (another tab, a trade or a restore). Reload to continue.',
    }
  return null
}

/** Import (FR-25) only starts an empty slot. */
export function checkImport(slot: SlotState, size: number): Rejection | null {
  if (slot.deletedAt) return { status: 404, code: 'slot_deleted', message: 'This slot was deleted.' }
  if (slot.currentVersionId)
    return { status: 409, code: 'slot_not_empty', message: 'Saves can only be imported into an empty slot.' }
  if (!isAcceptedSaveSize(slot.platform, size)) return badSize(slot.platform)
  return null
}

export function badSize(platform: Platform): Rejection {
  return { status: 413, code: 'bad_size', message: `That is not a ${PLATFORMS[platform].name} save file.` }
}

/**
 * ADR-007: never restore a version older than the slot's last trade — that
 * would hand back a Pokémon that now lives in someone else's game.
 */
export function checkRestore(
  slot: SlotState,
  target: { slotId: string; seq: number },
  lastTradeSeq: number | null,
): Rejection | null {
  if (slot.deletedAt) return { status: 404, code: 'slot_deleted', message: 'This slot was deleted.' }
  if (target.slotId !== slot.id) return { status: 404, code: 'not_found', message: 'Version not found.' }
  if (slot.lockedByTradeId)
    return { status: 423, code: 'slot_locked', message: 'This save is locked while a trade finishes.' }
  if (lastTradeSeq !== null && target.seq < lastTradeSeq)
    return {
      status: 409,
      code: 'before_trade',
      message: "You can't restore a save from before a trade.",
    }
  return null
}

/**
 * FR-10: an admin may bring back a deleted slot within SLOT_RECOVERY_DAYS, if
 * the owner has room. It keeps its slot number when that is still free.
 */
export function checkRecover(
  slot: { deletedAt: Date | null; slotNumber: number },
  liveSlotNumbers: number[],
  now = new Date(),
): Rejection | { slotNumber: number } {
  if (!slot.deletedAt) return { status: 409, code: 'not_deleted', message: 'This slot is not deleted.' }
  if (now.getTime() - slot.deletedAt.getTime() > SLOT_RECOVERY_DAYS * 24 * 3600 * 1000)
    return { status: 409, code: 'recovery_expired', message: `Slots can only be recovered within ${SLOT_RECOVERY_DAYS} days.` }
  if (liveSlotNumbers.length >= MAX_SLOTS)
    return { status: 409, code: 'slots_full', message: `The player already has ${MAX_SLOTS} games; one must be deleted first.` }
  const free = Array.from({ length: MAX_SLOTS }, (_, i) => i + 1).filter((n) => !liveSlotNumbers.includes(n))
  return { slotNumber: free.includes(slot.slotNumber) ? slot.slotNumber : free[0] }
}
