import { NextResponse } from 'next/server'
import { sendVerificationEmail } from '@/lib/email-tokens'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-01: send a new verification link; earlier ones stop working. */
export const POST = route(async () => {
  const user = await requireUser()
  if (user.emailVerifiedAt) throw new HttpError(409, 'already_verified', 'Your email is already verified.')
  if (!(await rateLimit(`verify-resend:${user.id}`, 3, 3600)))
    throw new HttpError(429, 'rate_limited', 'Too many emails. Try again in an hour.')
  await sendVerificationEmail(user.id, user.email)
  return new NextResponse(null, { status: 204 })
})
