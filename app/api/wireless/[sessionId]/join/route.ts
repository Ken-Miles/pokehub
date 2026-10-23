import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'
import { joinRoom } from '@/lib/wireless'

type Ctx = { params: Promise<{ sessionId: string }> }

/** FR-35: accept a room invite; my adapter joins. */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await joinRoom(user, (await params).sessionId)
  return new NextResponse(null, { status: 204 })
})
