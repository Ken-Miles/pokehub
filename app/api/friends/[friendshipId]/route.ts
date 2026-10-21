import { NextResponse } from 'next/server'
import { acceptFriendRequest, removeFriendship } from '@/lib/friends'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ friendshipId: string }> }

/** FR-03: accept a request sent to me. Needs a verified email. */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await acceptFriendRequest(user, (await params).friendshipId)
  return new NextResponse(null, { status: 204 })
})

/** FR-03: decline, cancel or remove — either side may. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await removeFriendship(user, (await params).friendshipId)
  return new NextResponse(null, { status: 204 })
})
