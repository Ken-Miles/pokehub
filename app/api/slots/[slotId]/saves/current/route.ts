import { HttpError, route } from '@/lib/http'
import { prisma } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { loadOwnSlot } from '@/lib/slots'
import { getSave } from '@/lib/storage'

type Ctx = { params: Promise<{ slotId: string }> }

/** The slot's current save, for loading into the emulator. 204 = new slot, no save yet. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const slot = await loadOwnSlot(user.id, (await params).slotId)
  if (!slot.currentVersionId) return new Response(null, { status: 204, headers: { 'x-version-id': 'none' } })
  const version = await prisma.saveVersion.findUnique({ where: { id: slot.currentVersionId } })
  if (!version) throw new HttpError(404, 'not_found')
  const bytes = await getSave(version.storageKey)
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'x-version-id': version.id,
      'x-locked': slot.lockedByTradeId ? '1' : '0',
      'cache-control': 'no-store',
    },
  })
})
