import { NextResponse } from 'next/server'
import { DROP_DAILY_LIMIT } from '@/lib/dropbox-rules'
import { listOwnDropFiles, readDropBody, requireTester, uploadDropFile } from '@/lib/dropbox'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-32: a tester's own drop-box files. */
export const GET = route(async () => {
  const user = await requireUser()
  return NextResponse.json({ files: await listOwnDropFiles(user) })
})

/**
 * FR-32: drop one file. Body = the raw file. `x-file-name` and the optional
 * `x-note` are URI-encoded. Not a save version (ADR-015).
 */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  requireTester(user)
  if (!(await rateLimit(`dropbox:${user.id}`, DROP_DAILY_LIMIT, 24 * 3600)))
    throw new HttpError(429, 'rate_limited', `That's ${DROP_DAILY_LIMIT} files today — try again tomorrow.`)
  const bytes = await readDropBody(req)
  const file = await uploadDropFile(user, {
    bytes,
    fileName: header(req, 'x-file-name') ?? 'save.sav',
    note: header(req, 'x-note'),
  })
  return NextResponse.json(
    { file: { id: file.id, fileName: file.fileName, size: file.size, readable: file.readable } },
    { status: 201 },
  )
})

function header(req: Request, name: string): string | null {
  const raw = req.headers.get(name)
  if (raw === null) return null
  try {
    return decodeURIComponent(raw)
  } catch {
    throw new HttpError(400, 'invalid', `${name} must be URI-encoded.`)
  }
}
