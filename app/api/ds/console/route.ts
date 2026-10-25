import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { WIFI_SETTINGS_BYTES } from '@/lib/ds-console'
import { HttpError, route } from '@/lib/http'
import { rateLimit } from '@/lib/rate-limit'
import { requireUser } from '@/lib/session'

/** FR-39: my DS's saved Wi-Fi settings (base64, or null), to boot it with. */
export const GET = route(async () => {
  const user = await requireUser()
  const ds = await prisma.dsConsole.findUnique({ where: { userId: user.id } })
  return NextResponse.json({ wifiSettings: ds?.wifiSettings ? Buffer.from(ds.wifiSettings).toString('base64') : null })
})

/** FR-39: the DS wrote its Wi-Fi settings; body = the raw 768 bytes. */
export const PUT = route(async (req: Request) => {
  const user = await requireUser()
  if (!(await rateLimit(`ds-console:${user.id}`, 20, 60))) throw new HttpError(429, 'rate_limited', 'Too many requests. Try later.')
  if (Number(req.headers.get('content-length') ?? 0) > WIFI_SETTINGS_BYTES) throw new HttpError(400, 'bad_size')
  const bytes = new Uint8Array(await req.arrayBuffer())
  if (bytes.length !== WIFI_SETTINGS_BYTES) throw new HttpError(400, 'bad_size', `Wi-Fi settings are ${WIFI_SETTINGS_BYTES} bytes.`)
  await prisma.dsConsole.upsert({
    where: { userId: user.id },
    create: { userId: user.id, wifiSettings: bytes },
    update: { wifiSettings: bytes },
  })
  return new NextResponse(null, { status: 204 })
})
