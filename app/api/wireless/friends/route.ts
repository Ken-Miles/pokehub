import { NextResponse } from 'next/server'
import { HttpError, route } from '@/lib/http'
import { requireUser } from '@/lib/session'
import { roomFriends } from '@/lib/wireless'

/** FR-35: friends playing FireRed, LeafGreen or Emerald right now, who my room could invite. */
export const GET = route(async (req: Request) => {
  const user = await requireUser()
  const slotId = new URL(req.url).searchParams.get('slotId')
  if (!slotId || slotId.length > 40) throw new HttpError(400, 'invalid')
  return NextResponse.json({ friends: await roomFriends(user, slotId) })
})
