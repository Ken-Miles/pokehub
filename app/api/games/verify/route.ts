import { NextResponse } from 'next/server'
import { z } from 'zod'
import { HttpError, route } from '@/lib/http'
import { checkRom, romRejectionMessage } from '@/lib/rom-allowlist'
import { requireUser } from '@/lib/session'

const body = z.object({
  platform: z.enum(['GB', 'GBA', 'NDS', 'N3DS']).default('GBA'),
  code: z.string().length(4),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i),
})

/** FR-05: the browser sends only the platform, header code + SHA-1, never the file. */
export const POST = route(async (req: Request) => {
  await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  const { platform, code, sha1 } = parsed.data
  const verdict = checkRom(platform, code, sha1)
  if (!verdict.ok) throw new HttpError(422, verdict.reason, romRejectionMessage(verdict.reason, platform))
  return NextResponse.json({ game: verdict.game })
})
