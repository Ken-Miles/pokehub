import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { endSession, sessionView } from '@/lib/link-sessions'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string }> }

/** FR-26: the lobby / session, for its players only. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  return NextResponse.json(await sessionView(user, (await params).sessionId))
})

/** FR-26: leave — which unplugs the cable for everyone. `?reason=desync` when the browser saw one. */
export const DELETE = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const reason = new URL(req.url).searchParams.get('reason') === 'desync' ? 'desync' : 'left'
  await endSession(user.id, (await params).sessionId, reason)
  return new NextResponse(null, { status: 204 })
})
