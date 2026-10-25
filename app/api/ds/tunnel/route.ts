import { NextResponse } from 'next/server'
import { dsMac, tunnelTicket } from '@/lib/ds-tunnel'
import { env } from '@/lib/env'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-38: a ticket for the signed-in user's DS to open its network tunnel, plus the DS's MAC. */
export const POST = route(async () => {
  const user = await requireUser()
  const { DS_GATEWAY_SECRET: secret, DS_GATEWAY_URL: url } = env()
  if (!secret || !url) throw new HttpError(404, 'ds_online_off', 'DS online play is not switched on.')
  if (!(await rateLimit(`ds-tunnel:${user.id}`, 10, 60))) throw new HttpError(429, 'rate_limited', 'Too many requests. Try later.')
  return NextResponse.json({ url, ticket: tunnelTicket(user.id, secret), mac: dsMac(user.id) })
})
