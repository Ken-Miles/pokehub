import { NextResponse } from 'next/server'
import { z } from 'zod'
import { prisma } from '@/lib/db'
import { HttpError, route } from '@/lib/http'
import { requireUser } from '@/lib/session'

const ACTIONS = new Set(['a', 'b', 'x', 'y', 'l', 'r', 'start', 'select', 'up', 'down', 'left', 'right', 'save', 'load', 'slot'])
const RESERVED_KEYS = new Set(['Escape', 'F5', 'F11', 'F12', 'MetaLeft', 'MetaRight', 'Tab'])
const bindingMap = z.record(z.string().max(40), z.string().max(40).nullable()).refine(
  (bindings) => Object.entries(bindings).every(([action, key]) =>
    ACTIONS.has(action) && (key === null || (/^[A-Za-z][A-Za-z0-9]*$/.test(key) && !RESERVED_KEYS.has(key))),
  ),
)

/** The signed-in user's emulator keyboard map. */
export const GET = route(async () => {
  const user = await requireUser()
  return NextResponse.json({ bindings: user.emulatorControls })
})

/** Save emulator key remaps to the account so they follow the user between devices. */
export const PUT = route(async (req: Request) => {
  const user = await requireUser()
  const parsed = z.object({ bindings: bindingMap }).strict().safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid', 'Invalid emulator controls.')
  await prisma.user.update({ where: { id: user.id }, data: { emulatorControls: parsed.data.bindings } })
  return NextResponse.json({ ok: true })
})
