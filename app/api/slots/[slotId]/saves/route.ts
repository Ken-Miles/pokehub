import { NextResponse } from 'next/server'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { ingestSave } from '@/lib/save-pipeline'
import { requireUser } from '@/lib/session'
import { loadOwnSlot, readSaveBody } from '@/lib/slots'

type Ctx = { params: Promise<{ slotId: string }> }

/**
 * FR-08: emulator sync. Body = raw save bytes. Header `x-parent-version` names
 * the version this save was built on ("none" for a brand-new slot) — ADR-006.
 */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  if (!(await rateLimit(`upload:${user.id}`, 30, 60))) throw new HttpError(429, 'rate_limited', 'Syncing too fast.')
  const slot = await loadOwnSlot(user.id, (await params).slotId)

  const parentHeader = req.headers.get('x-parent-version')
  if (!parentHeader) throw new HttpError(400, 'missing_parent', 'x-parent-version header is required.')
  const parentVersionId = parentHeader === 'none' ? null : parentHeader

  const bytes = await readSaveBody(req)
  const { version, created, conflicts } = await ingestSave({
    slot,
    bytes,
    parentVersionId,
    source: 'EMULATOR',
    actorId: user.id,
  })
  return NextResponse.json({ versionId: version.id, seq: version.seq, created, flagged: conflicts.length }, { status: created ? 201 : 200 })
})
