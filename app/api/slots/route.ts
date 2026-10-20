import { NextResponse } from 'next/server'
import { z } from 'zod'
import { audit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { identifyGame } from '@/lib/games'
import { HttpError, route } from '@/lib/http'
import { checkRom } from '@/lib/rom-allowlist'
import { requireUser } from '@/lib/session'
import { MAX_SLOTS } from '@/lib/slots'

export const GET = route(async () => {
  const user = await requireUser()
  const slots = await prisma.gameSlot.findMany({
    where: { userId: user.id, deletedAt: null },
    orderBy: { slotNumber: 'asc' },
    include: { currentVersion: { select: { id: true, seq: true, playSeconds: true, createdAt: true } } },
  })
  return NextResponse.json({
    slots: slots.map((s) => ({ ...s, game: identifyGame(s.gameCode) })),
    max: MAX_SLOTS,
  })
})

const createBody = z.object({
  code: z.string().length(4),
  sha1: z.string().regex(/^[0-9a-f]{40}$/i),
  origin: z.enum(['NEW', 'IMPORTED']),
})

/** FR-10: create a slot bound to one game. Its first save comes from the emulator or an import. */
export const POST = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = createBody.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  const { code, sha1, origin } = parsed.data

  const verdict = checkRom(code, sha1)
  if (!verdict.ok) throw new HttpError(422, verdict.reason, 'That game file is not supported.')
  const game = identifyGame(code)!

  const used = await prisma.gameSlot.findMany({ where: { userId: user.id, deletedAt: null }, select: { slotNumber: true } })
  const free = [1, 2, 3].find((n) => !used.some((u) => u.slotNumber === n))
  if (!free) throw new HttpError(409, 'slots_full', `You can have up to ${MAX_SLOTS} games. Delete one first.`)

  const slot = await prisma.gameSlot.create({
    data: { userId: user.id, slotNumber: free, gameCode: code, language: game.language, origin },
  })
  await audit({ actorId: user.id, action: 'slot.create', targetType: 'slot', targetId: slot.id, payload: { code, origin } })
  return NextResponse.json({ slot }, { status: 201 })
})
