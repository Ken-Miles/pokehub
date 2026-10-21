import type { GameSlot } from '@prisma/client'
import { prisma } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { maxSaveBytes } from '@/lib/games'
import { badSize } from '@/lib/save-rules'

export { MAX_SLOTS } from '@/lib/save-rules'

export async function loadOwnSlot(userId: string, slotId: string): Promise<GameSlot> {
  const slot = await prisma.gameSlot.findFirst({ where: { id: slotId, userId, deletedAt: null } })
  if (!slot) throw new HttpError(404, 'not_found', 'Slot not found.')
  return slot
}

/**
 * Read a save upload for a slot. Refuses anything bigger than that platform's
 * largest save before buffering it, so a game file can't be pushed through (NFR-01).
 */
export async function readSaveBody(req: Request, slot: Pick<GameSlot, 'platform'>): Promise<Uint8Array> {
  const max = maxSaveBytes(slot.platform)
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > max) throw HttpError.from(badSize(slot.platform))
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length > max) throw HttpError.from(badSize(slot.platform))
  return bytes
}
