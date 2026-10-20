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
