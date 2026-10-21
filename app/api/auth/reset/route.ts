import { NextResponse } from 'next/server'
import { z } from 'zod'
import { emailSchema } from '@/lib/account-rules'
import { clientIp } from '@/lib/client-ip'
import { prisma } from '@/lib/db'
import { sendResetEmail } from '@/lib/email-tokens'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'

const body = z.object({ email: emailSchema })

/**
 * FR-01: ask for a password reset link (1 h). Always 204, so the answer never
 * tells anyone whether an email is registered.
 */
export const POST = route(async (req: Request) => {
  const ip = clientIp(req.headers)
  if (!(await rateLimit(`reset:${ip}`, 5, 3600))) throw new HttpError(429, 'rate_limited', 'Too many requests. Try later.')

  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0].message)
  const { email } = parsed.data

  const user = await prisma.user.findUnique({ where: { email } })
  // Per-address limit too, so one inbox can't be flooded from many IPs.
  if (user && (await rateLimit(`reset:${user.id}`, 3, 3600))) {
    await sendResetEmail(user.id, user.email)
    await prisma.authEvent.create({ data: { userId: user.id, username: user.username, event: 'password_reset_requested', ip } })
  }
  return new NextResponse(null, { status: 204 })
})
