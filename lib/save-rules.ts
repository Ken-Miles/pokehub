/**
 * Pure rules for accepting uploads and restores. Kept free of I/O so the
 * anti-duplication invariants are unit-tested (tests/save-rules.test.ts).
 */

/** Gen 3 flash is 128 KB; some emulators append a 16-byte RTC footer (NFR-01). */
export const GBA_SAVE_SIZES = [131_072, 131_088] as const
export const MAX_SAVE_BYTES = 131_088

export function isAcceptedSaveSize(size: number): boolean {
  return (GBA_SAVE_SIZES as readonly number[]).includes(size)
}

export interface Rejection {
  status: 400 | 404 | 409 | 413 | 423
  code: string
  message: string
}

export interface SlotState {
  id: string
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
  if (!isAcceptedSaveSize(size))
    return { status: 413, code: 'bad_size', message: 'That is not a Game Boy Advance save file.' }
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
  if (!isAcceptedSaveSize(size))
    return { status: 413, code: 'bad_size', message: 'That is not a Game Boy Advance save file.' }
  return null
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
