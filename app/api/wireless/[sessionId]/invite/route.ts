import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'
import { inviteToRoom } from '@/lib/wireless'

type Ctx = { params: Promise<{ sessionId: string }> }

const body = z.object({ friendId: z.string().min(1).max(40) })

/** FR-35: invite an online friend into my room. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  if (!(await rateLimit(`wireless-invite:${user.id}`, 60, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many invites. Try again later.')
  await inviteToRoom(user, (await params).sessionId, parsed.data.friendId)
  return new NextResponse(null, { status: 204 })
})
