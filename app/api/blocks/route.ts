import { NextResponse } from 'next/server'
import { z } from 'zod'
import { blockPlayer, findPlayer } from '@/lib/friends'
import { HttpError, route } from '@/lib/http'
import { requireUser } from '@/lib/session'

const body = z.object({ player: z.string().trim().min(1).max(40) })

/** FR-03: block by username or friend code. Works without a verified email. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Enter a username or friend code.')
  await blockPlayer(user, await findPlayer(parsed.data.player))
  return new NextResponse(null, { status: 204 })
})
