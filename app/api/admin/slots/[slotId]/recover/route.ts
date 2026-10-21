import { NextResponse } from 'next/server'
import { recoverSlot } from '@/lib/admin-slots'
import { route } from '@/lib/http'
import { requireRole } from '@/lib/session'

type Ctx = { params: Promise<{ slotId: string }> }

/** FR-10: undo a slot delete within 30 days. Audit-logged as admin.slot.recover. */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const admin = await requireRole('ADMIN')
  return NextResponse.json(await recoverSlot(admin, (await params).slotId))
})
