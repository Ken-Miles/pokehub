import { NextResponse } from 'next/server'
import { listDropFilesForAdmin, listTesters } from '@/lib/dropbox'
import { route } from '@/lib/http'
import { requireRole } from '@/lib/session'

/** FR-32: every drop-box file and the current testers. */
export const GET = route(async () => {
  await requireRole('ADMIN')
  const [files, testers] = await Promise.all([listDropFilesForAdmin(), listTesters()])
  return NextResponse.json({
    files,
    testers: testers.map((t) => ({ id: t.id, username: t.username, files: t._count.dropFiles })),
  })
})
