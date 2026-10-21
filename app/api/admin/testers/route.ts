import { NextResponse } from 'next/server'
import { z } from 'zod'
import { setTester } from '@/lib/dropbox'
import { HttpError, route } from '@/lib/http'
import { requireRole } from '@/lib/session'

const Body = z.object({ username: z.string().min(1).max(40), tester: z.boolean() })

/** FR-32: add or remove a drop-box tester. */
export const POST = route(async (req: Request) => {
  const admin = await requireRole('ADMIN')
  const body = Body.safeParse(await req.json())
  if (!body.success) throw new HttpError(400, 'invalid', 'Give a username and tester true/false.')
  return NextResponse.json(await setTester(admin, body.data.username, body.data.tester))
})
