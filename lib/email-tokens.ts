import type { EmailToken, EmailTokenKind, Prisma } from '@prisma/client'
import { TOKEN_TTL_MS, emailTokenProblem } from '@/lib/account-rules'
import { prisma } from '@/lib/db'
import { sendMail } from '@/lib/mailer'
import { hashToken, newToken } from '@/lib/tokens'

type Tx = Prisma.TransactionClient

/**
 * Issue a fresh emailed link of `kind`, retiring any earlier unused ones so
 * only the newest link works. Returns the raw token to put in the email.
 */
async function issueEmailToken(userId: string, kind: EmailTokenKind): Promise<string> {
  const { token, tokenHash } = newToken()
  await prisma.$transaction([
    prisma.emailToken.updateMany({ where: { userId, kind, usedAt: null }, data: { usedAt: new Date() } }),
    prisma.emailToken.create({ data: { userId, kind, tokenHash, expiresAt: new Date(Date.now() + TOKEN_TTL_MS[kind]) } }),
  ])
  return token
}

/**
 * Use up an emailed link inside `tx`. The used-at stamp is a compare-and-swap,
 * so two clicks on the same link can't both succeed.
 */
export async function consumeEmailToken(
  tx: Tx,
  token: string,
  kind: EmailTokenKind,
): Promise<{ row: EmailToken; problem: null } | { row: null; problem: 'invalid' | 'used' | 'expired' }> {
  const row = token ? await tx.emailToken.findUnique({ where: { tokenHash: hashToken(token) } }) : null
  const problem = emailTokenProblem(row, kind)
  if (problem || !row) return { row: null, problem: problem ?? 'invalid' }
  const used = await tx.emailToken.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: new Date() } })
  if (used.count !== 1) return { row: null, problem: 'used' }
  return { row, problem: null }
}

function appLink(path: string): string {
  return `${process.env.NEXTAUTH_URL}${path}`
}

export async function sendVerificationEmail(userId: string, email: string): Promise<void> {
  const token = await issueEmailToken(userId, 'VERIFY_EMAIL')
  const link = appLink(`/api/auth/verify?token=${token}`)
  await sendMail(email, 'Verify your email', `Confirm your email to add friends and trade (link valid 24 hours): ${link}`)
}

export async function sendResetEmail(userId: string, email: string): Promise<void> {
  const token = await issueEmailToken(userId, 'RESET_PASSWORD')
  const link = appLink(`/reset?token=${token}`)
  await sendMail(
    email,
    'Reset your password',
    `Choose a new password (link valid 1 hour; it signs you out everywhere): ${link}\n` +
      "If you didn't ask for this, ignore this email — your password stays the same.",
  )
}
