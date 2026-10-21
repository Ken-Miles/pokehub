import type { Prisma } from '@prisma/client'
import { prisma } from '@/lib/db'

type Tx = Prisma.TransactionClient

/** Append-only audit log (FR-24). Pass `tx` to write inside a transaction. */
export async function audit(
  event: { actorId: string | null; action: string; targetType: string; targetId: string; payload?: Prisma.InputJsonValue },
  tx: Tx = prisma,
): Promise<void> {
  await tx.auditEvent.create({ data: event })
}

export interface AuditFilter {
  /** Events by this user, or about them or any of their slots (deleted ones too). */
  userId?: string
  slotId?: string
  tradeId?: string
  /** Action prefix, e.g. "save." or "slot.delete". */
  action?: string
  /** Id of the last event already shown; the next page starts after it. */
  cursor?: string
  limit?: number
}

/** FR-24: newest first, filtered for the admin audit view. */
export async function queryAudit(filter: AuditFilter) {
  const and: Prisma.AuditEventWhereInput[] = []
  if (filter.userId) {
    const slots = await prisma.gameSlot.findMany({ where: { userId: filter.userId }, select: { id: true } })
    and.push({
      OR: [
        { actorId: filter.userId },
        { targetType: 'user', targetId: filter.userId },
        { targetType: 'slot', targetId: { in: slots.map((s) => s.id) } },
      ],
    })
  }
  if (filter.slotId) and.push({ targetType: 'slot', targetId: filter.slotId })
  if (filter.tradeId) and.push({ targetType: 'trade', targetId: filter.tradeId })
  if (filter.action) and.push({ action: { startsWith: filter.action } })

  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)
  const events = await prisma.auditEvent.findMany({
    where: { AND: and },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  })
  const page = events.slice(0, limit)

  // Actor ids are plain (no FK, see schema); resolve the ones still around to names.
  const actorIds = [...new Set(page.map((e) => e.actorId).filter((id): id is string => !!id))]
  const actors = await prisma.user.findMany({ where: { id: { in: actorIds } }, select: { id: true, username: true } })
  const names = new Map(actors.map((a) => [a.id, a.username]))

  return {
    events: page.map((e) => ({ ...e, actor: e.actorId ? (names.get(e.actorId) ?? null) : null })),
    nextCursor: events.length > limit ? page[page.length - 1].id : null,
  }
}
