import { NextResponse } from 'next/server'
import { queryLinkTrades } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { HttpError, route } from '@/lib/http'
import { requireRole } from '@/lib/session'

/** FR-37: Pokémon traded in-game over a link (cable, wireless room, /link), for admins. */
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
  const result = await queryLinkTrades({ userId, cursor: q.get('cursor') || undefined, limit: Number(q.get('limit') ?? 50) || 50 })
  return NextResponse.json(result)
})
