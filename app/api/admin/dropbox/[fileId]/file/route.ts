import { attachmentHeader } from '@/lib/dropbox-rules'
import { readDropFile } from '@/lib/dropbox'
import { route } from '@/lib/http'
import { requireRole } from '@/lib/session'

type Ctx = { params: Promise<{ fileId: string }> }

/** FR-32: download the exact bytes a tester uploaded, under its original name. Audit-logged. */
export const GET = route(async (_req: Request, { params }: Ctx) => {
  const admin = await requireRole('ADMIN')
  const { file, bytes } = await readDropFile(admin, (await params).fileId)
  return new Response(Buffer.from(bytes), {
    headers: {
      'content-type': 'application/octet-stream',
      'content-disposition': attachmentHeader(file.fileName),
      'x-content-type-options': 'nosniff',
      'cache-control': 'no-store',
    },
  })
})
