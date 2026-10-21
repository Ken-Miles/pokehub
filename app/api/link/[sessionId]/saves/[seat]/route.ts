import { HttpError, route } from '@/lib/http'
import { seatStartSave } from '@/lib/link-sessions'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string; seat: string }> }

/**
 * FR-26 / ADR-012: the save a seat started the session from. Every browser in
 * a running session runs every seat's game, so every player may read it —
 * only while the session runs. 204 = a new game with no save yet.
 */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const { sessionId, seat } = await params
  if (!/^[0-3]$/.test(seat)) throw new HttpError(400, 'invalid')
  const save = await seatStartSave(user, sessionId, Number(seat))
  if (!save) return new Response(null, { status: 204, headers: { 'x-version-id': 'none', 'cache-control': 'no-store' } })
  return new Response(Buffer.from(save.bytes), {
    headers: { 'content-type': 'application/octet-stream', 'x-version-id': save.versionId, 'cache-control': 'no-store' },
  })
})
