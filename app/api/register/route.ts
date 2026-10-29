import { NextResponse } from 'next/server'
import { z } from 'zod'
import { emailSchema, passwordSchema, usernameSchema } from '@/lib/account-rules'
import { clientIp } from '@/lib/client-ip'
import { prisma } from '@/lib/db'
import { sendVerificationEmail } from '@/lib/email-tokens'
import { newFriendCode } from '@/lib/friend-code'
import { HttpError, route } from '@/lib/http'
import { hashPassword } from '@/lib/password'
import { logger } from '@/lib/logger'
import { mailBudgetLeft } from '@/lib/mailer'
import { rateLimit } from '@/lib/rate-limit'

const body = z.object({ username: usernameSchema, email: emailSchema, password: passwordSchema })

/** FR-01: sign up. Unverified accounts can play and sync, not trade. */
export const POST = route(async (req: Request) => {
  const ip = clientIp(req.headers)
  if (!(await rateLimit(`register:${ip}`, 5, 3600))) throw new HttpError(429, 'rate_limited', 'Too many sign-ups. Try later.')

  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0].message)
  const { username, email, password } = parsed.data

  // One verification email per account, and no resend: check the budget before creating anything.
  if (!(await mailBudgetLeft())) throw new HttpError(503, 'mail_unavailable', 'Sign-ups are paused while we send the verification emails. Try again later.')

  const taken = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { username: true } })
  if (taken) {
    throw new HttpError(409, 'taken', taken.username === username ? 'That username is taken.' : 'That email is already registered.')
  }

  const passwordHash = await hashPassword(password)
  let user
  for (let attempt = 0; ; attempt++) {
    try {
      user = await prisma.user.create({ data: { username, email, passwordHash, friendCode: newFriendCode() } })
      break
    } catch (e) {
      if (attempt >= 3) throw e // friend code collision is astronomically rare
    }
  }

  try {
    await sendVerificationEmail(user.id, email)
  } catch (err) {
    // No email, no account: otherwise nobody could ever verify it (there is no resend).
    logger.error({ err, userId: user.id }, 'verification email failed; account removed')
    await prisma.user.delete({ where: { id: user.id } })
    throw new HttpError(503, 'mail_unavailable', "We couldn't send your verification email. Please try signing up again.")
  }
  return NextResponse.json({ id: user.id, username: user.username }, { status: 201 })
})
