import { NextResponse } from 'next/server'
import { HttpError, route } from '@/lib/http'
import { ingestSave } from '@/lib/save-pipeline'
import { requireUser } from '@/lib/session'
import { loadOwnSlot, readSaveBody } from '@/lib/slots'

type Ctx = { params: Promise<{ slotId: string }> }

/** FR-25: start an empty IMPORTED slot from an existing .sav. Its Pokémon start unverified (ADR-008). */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const slot = await loadOwnSlot(user.id, (await params).slotId)
  if (slot.origin !== 'IMPORTED') throw new HttpError(400, 'not_import_slot', 'This slot was created for a new game.')
  const bytes = await readSaveBody(req, slot)
  const { version, conflicts } = await ingestSave({ slot, bytes, parentVersionId: null, source: 'IMPORT', actorId: user.id })
  return NextResponse.json({ versionId: version.id, seq: version.seq, flagged: conflicts.length }, { status: 201 })
})
