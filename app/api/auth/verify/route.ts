import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { consumeEmailToken } from '@/lib/email-tokens'

/** FR-01: single-use email verification link (24 h). */
export async function GET(req: Request) {
  const url = new URL(req.url)
  const token = url.searchParams.get('token') ?? ''
  const valid = await prisma.$transaction(async (tx) => {
    const { row } = await consumeEmailToken(tx, token, 'VERIFY_EMAIL')
    if (row) await tx.user.update({ where: { id: row.userId }, data: { emailVerifiedAt: new Date() } })
    return !!row
  })
  return NextResponse.redirect(new URL(valid ? '/slots?verified=1' : '/slots?verified=0', url))
}
