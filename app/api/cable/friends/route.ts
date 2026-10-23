import { NextResponse } from 'next/server'
import { HttpError, route } from '@/lib/http'
import { onlineFriends } from '@/lib/cable'
import { requireUser } from '@/lib/session'

/** FR-34: friends playing a game this slot's link cable fits, right now. */
export const GET = route(async (req: Request) => {
  const user = await requireUser()
  const slotId = new URL(req.url).searchParams.get('slotId')
  if (!slotId || slotId.length > 40) throw new HttpError(400, 'invalid')
  return NextResponse.json({ friends: await onlineFriends(user, slotId) })
})
