import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { startSession } from '@/lib/link-sessions'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string }> }

// The host's browser measures the round trip to the others and proposes the input delay.
const body = z.object({ inputDelay: z.number().int().min(1).max(6).default(3) })

/** FR-26: the host plugs the cable in. */
export const POST = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const parsed = body.safeParse(await req.json().catch(() => ({})))
  if (!parsed.success) throw new HttpError(400, 'invalid')
  await startSession(user, (await params).sessionId, parsed.data.inputDelay)
  return new NextResponse(null, { status: 204 })
})
