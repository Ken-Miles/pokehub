import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'

export const OPEN_TRADE_IDLE_MS = 15 * 60 * 1000 // FR-16
export const COMMIT_TIMEOUT_MS = 2 * 60 * 1000 // FR-14

/**
 * Trade housekeeping, run by the worker every minute.
 * - OPEN trades past their expiry → EXPIRED (no locks are held while open).
 * - COMMITTING trades older than 2 min → FAILED, locks released. The commit is
 *   one transaction (ADR-005), so a dead worker leaves either a finished trade
 *   or untouched originals; this only has to free the slots.
 */
export async function sweepTrades(now = new Date()): Promise<{ expired: number; failed: number }> {
  const expired = await prisma.trade.updateMany({
    where: { state: 'OPEN', expiresAt: { lt: now } },
    data: { state: 'EXPIRED' },
  })

  const stuck = await prisma.trade.findMany({
    where: { state: 'COMMITTING', updatedAt: { lt: new Date(now.getTime() - COMMIT_TIMEOUT_MS) } },
    select: { id: true },
  })
  let failed = 0
  for (const { id } of stuck) {
    await prisma.$transaction(async (tx) => {
      const r = await tx.trade.updateMany({
        where: { id, state: 'COMMITTING' },
        data: { state: 'FAILED', failureReason: 'commit_timeout' },
      })
      if (r.count === 0) return // committed or failed in the meantime
      await tx.gameSlot.updateMany({ where: { lockedByTradeId: id }, data: { lockedByTradeId: null } })
      await audit({ actorId: null, action: 'trade.failed', targetType: 'trade', targetId: id, payload: { reason: 'commit_timeout' } }, tx)
      failed++
    })
  }
  return { expired: expired.count, failed }
}
