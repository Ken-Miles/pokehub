import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { HttpError, route } from '@/lib/http'
import { sendMail } from '@/lib/mailer'
import { hashPassword } from '@/lib/password'
import { rateLimit } from '@/lib/rate-limit'
import { newToken } from '@/lib/tokens'

const body = z.object({
  username: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9_]{3,20}$/, 'Username: 3–20 letters, numbers or _'),
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(10, 'Password: at least 10 characters').max(200),
})

/** FR-01: sign up. Unverified accounts can play and sync, not trade. */
export const POST = route(async (req: Request) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!(await rateLimit(`register:${ip}`, 5, 3600))) throw new HttpError(429, 'rate_limited', 'Too many sign-ups. Try later.')

  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0].message)
  const { username, email, password } = parsed.data

  const taken = await prisma.user.findFirst({ where: { OR: [{ username }, { email }] }, select: { username: true } })
  if (taken) {
    throw new HttpError(409, 'taken', taken.username === username ? 'That username is taken.' : 'That email is already registered.')
  }

  const passwordHash = await hashPassword(password)
  const { token, tokenHash } = newToken()
  let user
  for (let attempt = 0; ; attempt++) {
    try {
      user = await prisma.user.create({
        data: {
          username,
          email,
          passwordHash,
          friendCode: newFriendCode(),
          emailTokens: {
            create: { kind: 'VERIFY_EMAIL', tokenHash, expiresAt: new Date(Date.now() + 24 * 3600 * 1000) },
          },
        },
      })
      break
    } catch (e) {
      if (attempt >= 3) throw e // friend code collision is astronomically rare
    }
  }

  const link = `${process.env.NEXTAUTH_URL}/api/auth/verify?token=${token}`
  await sendMail(email, 'Verify your email', `Confirm your email to start trading: ${link}`)
  return NextResponse.json({ id: user.id, username: user.username }, { status: 201 })
})
