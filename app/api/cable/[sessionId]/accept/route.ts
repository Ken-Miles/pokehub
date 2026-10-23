import { NextResponse } from 'next/server'
import { route } from '@/lib/http'
import { acceptCable } from '@/lib/cable'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ sessionId: string }> }

/** FR-34: the friend who was asked plugs the cable in. Declining is DELETE /api/link/:id. */
export const POST = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await acceptCable(user, (await params).sessionId)
  return new NextResponse(null, { status: 204 })
})
