import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { createSession, mySessions } from '@/lib/link-sessions'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-26: my open link lobbies, running sessions and invites. */
export const GET = route(async () => {
  const user = await requireUser()
  return NextResponse.json({ sessions: await mySessions(user) })
})

const body = z.object({ mode: z.enum(['SAME_DEVICE', 'NETWORK']), slotId: z.string().min(1).max(40) })

/** FR-26: open a link lobby with one of my games in seat 0. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Choose a game and how you want to link.')
  if (!(await rateLimit(`link-create:${user.id}`, 30, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many link sessions. Try again later.')
  const id = await createSession(user, parsed.data.mode, parsed.data.slotId)
  return NextResponse.json({ id }, { status: 201 })
})
