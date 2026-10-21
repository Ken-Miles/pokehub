import { NextResponse } from 'next/server'
import { queryAudit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { HttpError, route } from '@/lib/http'
import { requireRole } from '@/lib/session'

/** FR-24: the audit log for admins, filtered by user, slot, trade and/or action. */
export const GET = route(async (req: Request) => {
  await requireRole('ADMIN')
  const q = new URL(req.url).searchParams
  const username = q.get('user')?.trim().toLowerCase()
  let userId: string | undefined
  if (username) {
    const user = await prisma.user.findUnique({ where: { username }, select: { id: true } })
    if (!user) throw new HttpError(404, 'not_found', 'No player with that username.')
    userId = user.id
  }
  const result = await queryAudit({
    userId,
    slotId: q.get('slot')?.trim() || undefined,
    tradeId: q.get('trade')?.trim() || undefined,
    action: q.get('action')?.trim() || undefined,
    cursor: q.get('cursor') || undefined,
    limit: Number(q.get('limit') ?? 50) || 50,
  })
  return NextResponse.json(result)
})
