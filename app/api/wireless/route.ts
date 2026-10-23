import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'
import { openRoom } from '@/lib/wireless'

const body = z.object({ slotId: z.string().min(1).max(40) })

/** FR-35: turn my Wireless Adapter on, opening a room with my running game. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  if (!(await rateLimit(`wireless-open:${user.id}`, 60, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many rooms. Try again later.')
  return NextResponse.json({ id: await openRoom(user, parsed.data.slotId) }, { status: 201 })
})
