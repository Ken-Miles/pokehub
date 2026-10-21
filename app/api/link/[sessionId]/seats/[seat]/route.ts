import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { updateSeat } from '@/lib/link-sessions'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string; seat: string }> }

// The game file's SHA-1 and the emulator build only — the file itself never leaves the browser (NFR-01).
const body = z.object({
  slotId: z.string().min(1).max(40),
  romSha1: z.string().regex(/^[0-9a-f]{40}$/i).optional(),
  coreBuild: z.string().regex(/^[0-9a-f]{16}$/).optional(),
})

/** FR-26: choose my seat's game; with romSha1 + coreBuild, also "ready". */
export const PUT = route(async (req: Request, { params }: Ctx) => {
  const user = await requireUser()
  const { sessionId, seat } = await params
  const parsed = body.safeParse(await req.json())
  if (!parsed.success || !/^[0-3]$/.test(seat)) throw new HttpError(400, 'invalid')
  await updateSeat(user, sessionId, Number(seat), parsed.data)
  return new NextResponse(null, { status: 204 })
})
