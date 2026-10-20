import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { HttpError, route } from '@/lib/http'
import { ingestSave } from '@/lib/save-pipeline'
import { checkRestore } from '@/lib/save-rules'
import { requireUser } from '@/lib/session'
import { loadOwnSlot } from '@/lib/slots'
import { getSave } from '@/lib/storage'

type Ctx = { params: Promise<{ slotId: string }> }
const body = z.object({ versionId: z.string() })

/** FR-09: restore = a new version copying an old one. Never past a trade (ADR-007). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const slot = await loadOwnSlot(user.id, (await params).slotId)
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')

  const target = await prisma.saveVersion.findUnique({ where: { id: parsed.data.versionId } })
  if (!target) throw new HttpError(404, 'not_found', 'Version not found.')
  const lastTrade = slot.lastTradeVersionId
    ? await prisma.saveVersion.findUnique({ where: { id: slot.lastTradeVersionId }, select: { seq: true } })
    : null
  const rejection = checkRestore(slot, target, lastTrade?.seq ?? null)
  if (rejection) throw HttpError.from(rejection)

  const bytes = await getSave(target.storageKey)
  const { version } = await ingestSave({
    slot,
    bytes,
    parentVersionId: slot.currentVersionId,
    source: 'RESTORE',
    actorId: user.id,
    restoredFromId: target.id,
  })
  return NextResponse.json({ versionId: version.id, seq: version.seq })
})
