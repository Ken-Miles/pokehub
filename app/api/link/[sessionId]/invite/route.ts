import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { inviteToSession } from '@/lib/link-sessions'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string }> }

const body = z.object({ to: z.string().trim().min(1).max(40) })

/** FR-26: the host invites a friend (username or friend code) to the next seat. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Enter a friend’s username or friend code.')
  if (!(await rateLimit(`link-invite:${user.id}`, 60, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many invites. Try again later.')
  await inviteToSession(user, (await params).sessionId, parsed.data.to)
  return new NextResponse(null, { status: 204 })
})
