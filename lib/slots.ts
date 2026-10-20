import type { GameSlot } from '@prisma/client'
import { prisma } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { MAX_SAVE_BYTES } from '@/lib/save-rules'

export const MAX_SLOTS = 3 // FR-10

export async function loadOwnSlot(userId: string, slotId: string): Promise<GameSlot> {
  const slot = await prisma.gameSlot.findFirst({ where: { id: slotId, userId, deletedAt: null } })
  if (!slot) throw new HttpError(404, 'not_found', 'Slot not found.')
  return slot
}

/**
 * Read a save upload. Refuses anything bigger than a save before buffering it,
 * so a game file can't be pushed through this route (NFR-01).
 */
export async function readSaveBody(req: Request): Promise<Uint8Array> {
  const declared = Number(req.headers.get('content-length') ?? 0)
  if (declared > MAX_SAVE_BYTES) throw new HttpError(413, 'bad_size', 'That is not a Game Boy Advance save file.')
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length > MAX_SAVE_BYTES) throw new HttpError(413, 'bad_size', 'That is not a Game Boy Advance save file.')
  return bytes
}
