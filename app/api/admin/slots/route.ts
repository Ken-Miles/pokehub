import { NextResponse } from 'next/server'
import { slotsForAdmin } from '@/lib/admin-slots'
import { HttpError, route } from '@/lib/http'
import { requireRole } from '@/lib/session'

/** FR-10: a player's slots, deleted ones included, for recovery. */
export const GET = route(async (req: Request) => {
  await requireRole('ADMIN')
  const username = new URL(req.url).searchParams.get('user')
  if (!username) throw new HttpError(400, 'invalid', 'Give a username.')
  return NextResponse.json(await slotsForAdmin(username))
})
