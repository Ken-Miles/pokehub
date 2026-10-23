import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'
import { leaveRoom } from '@/lib/wireless'

type Ctx = { params: Promise<{ sessionId: string }> }

/** FR-35: leave a room, or decline an invite. The host closes it with DELETE /api/link/:id. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await leaveRoom(user.id, (await params).sessionId, 'left')
  return new NextResponse(null, { status: 204 })
})
