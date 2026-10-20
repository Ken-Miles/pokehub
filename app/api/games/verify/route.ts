import { NextResponse } from 'next/server'
import { z } from 'zod'
import { identifyGame } from '@/lib/games'
import { HttpError, route } from '@/lib/http'
import { checkRom } from '@/lib/rom-allowlist'
import { requireUser } from '@/lib/session'

const body = z.object({ code: z.string().length(4), sha1: z.string().regex(/^[0-9a-f]{40}$/i) })

/** FR-05: the browser sends only the header code + SHA-1, never the file. */
export const POST = route(async (req: Request) => {
  await requireUser()
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  const verdict = checkRom(parsed.data.code, parsed.data.sha1)
  if (!verdict.ok) {
    const message =
      verdict.reason === 'unsupported_game'
        ? "That game isn't supported yet. Supported: Ruby, Sapphire, Emerald, FireRed, LeafGreen."
        : "That doesn't look like an unmodified copy of the game. ROM hacks aren't supported."
    throw new HttpError(422, verdict.reason, message)
  }
  return NextResponse.json({ game: identifyGame(parsed.data.code) })
})
