import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { requestCable } from '@/lib/cable'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

const body = z.object({ slotId: z.string().min(1).max(40), friendId: z.string().min(1).max(40) })

/** FR-34: ask a friend who's playing to plug a link cable into my running game. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  if (!(await rateLimit(`cable-request:${user.id}`, 60, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many link requests. Try again later.')
  const id = await requestCable(user, parsed.data.slotId, parsed.data.friendId)
  return NextResponse.json({ id }, { status: 201 })
})
