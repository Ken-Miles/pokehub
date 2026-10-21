import { deleteDropFile } from '@/lib/dropbox'
import { route } from '@/lib/http'
import { requireUser } from '@/lib/session'

type Ctx = { params: Promise<{ fileId: string }> }

/** FR-32: the uploader or an admin deletes a drop-box file. */
export const DELETE = route(async (_req: Request, { params }: Ctx) => {
  const user = await requireUser()
  await deleteDropFile(user, (await params).fileId)
  return new Response(null, { status: 204 })
})
