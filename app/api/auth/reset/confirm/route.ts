import { NextResponse } from 'next/server'
import { z } from 'zod'
import { passwordSchema } from '@/lib/account-rules'
import { prisma } from '@/lib/db'
import { consumeEmailToken } from '@/lib/email-tokens'
import { HttpError, route } from '@/lib/http'
import { hashPassword } from '@/lib/password'
import { rateLimit } from '@/lib/rate-limit'

const body = z.object({ token: z.string().min(1), password: passwordSchema })

const PROBLEM = {
  invalid: 'That reset link is not valid.',
  used: 'That reset link was already used. Ask for a new one.',
  expired: 'That reset link has expired. Ask for a new one.',
}

/**
 * FR-01: set a new password from a reset link. Bumps token_version, which signs
 * out every session (lib/session.ts). The link proves the inbox, so it also
 * verifies the email.
 */
export const POST = route(async (req: Request) => {
  const ip = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
  if (!(await rateLimit(`reset-confirm:${ip}`, 10, 3600))) throw new HttpError(429, 'rate_limited', 'Too many attempts. Try later.')

  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', parsed.error.issues[0].message)
  const { token, password } = parsed.data
  const passwordHash = await hashPassword(password)

  await prisma.$transaction(async (tx) => {
    const { row, problem } = await consumeEmailToken(tx, token, 'RESET_PASSWORD')
    if (!row) throw new HttpError(400, `token_${problem}`, PROBLEM[problem])
    const before = await tx.user.findUniqueOrThrow({ where: { id: row.userId }, select: { emailVerifiedAt: true } })
    const user = await tx.user.update({
      where: { id: row.userId },
      data: { passwordHash, tokenVersion: { increment: 1 }, emailVerifiedAt: before.emailVerifiedAt ?? new Date() },
    })
    await tx.authEvent.create({ data: { userId: user.id, username: user.username, event: 'password_reset', ip } })
  })
  return new NextResponse(null, { status: 204 })
})
