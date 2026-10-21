import { NextResponse } from 'next/server'
import { z } from 'zod'
import { findPlayer, listFriends, sendFriendRequest } from '@/lib/friends'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-03: my friends, requests both ways, and blocks. */
export const GET = route(async () => {
  const user = await requireUser()
  return NextResponse.json(await listFriends(user))
})

const body = z.object({ to: z.string().trim().min(1).max(40) })

/** FR-03: send a request by username or friend code. Needs a verified email. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Enter a username or friend code.')
  if (!(await rateLimit(`friend-request:${user.id}`, 20, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many friend requests. Try again later.')
  const them = await findPlayer(parsed.data.to)
  const result = await sendFriendRequest(user, them)
  return NextResponse.json({ result, username: them.username }, { status: result === 'requested' ? 201 : 200 })
})
