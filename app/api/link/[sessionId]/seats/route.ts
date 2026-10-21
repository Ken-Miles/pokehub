import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { addOwnSeat } from '@/lib/link-sessions'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string }> }

const body = z.object({ slotId: z.string().min(1).max(40) })

/** FR-26 same device: plug another of my games into the cable. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Choose a game.')
  await addOwnSeat(user, (await params).sessionId, parsed.data.slotId)
  return new NextResponse(null, { status: 204 })
})
