import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { hashToken } from '@/lib/tokens'

/** FR-01: single-use email verification link (24 h). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token') ?? ''
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hashToken(token) } })
  const valid = row && row.kind === 'VERIFY_EMAIL' && !row.usedAt && row.expiresAt > new Date()
  if (valid) {
    await prisma.$transaction([
      prisma.emailToken.update({ where: { id: row.id }, data: { usedAt: new Date() } }),
      prisma.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } }),
    ])
  }
  return NextResponse.redirect(new URL(valid ? '/slots?verified=1' : '/slots?verified=0', url))
}
