import { NextResponse } from 'next/server'
import { crashReport } from '@/lib/crash-report'
import { HttpError, route } from '@/lib/http'
import { logger } from '@/lib/logger'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** The browser's emulator crashed or wouldn't boot: log what it saw, with who and where. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  if (!(await rateLimit(`crash:${user.id}`, 20, 3600))) return new NextResponse(null, { status: 204 })
  const parsed = crashReport.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  logger.error({ userId: user.id, crash: parsed.data }, 'emulator crash')
  return new NextResponse(null, { status: 204 })
})
