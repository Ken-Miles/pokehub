import { NextResponse } from 'next/server'
import { unblockPlayer } from '@/lib/friends'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ userId: string }> }

/** FR-03: unblock. Any old friendship stays gone; they'd have to ask again. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await unblockPlayer(user, (await params).userId)
  return new NextResponse(null, { status: 204 })
})
