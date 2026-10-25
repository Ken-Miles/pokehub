import { NextResponse } from 'next/server'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import { accountBlock } from '@/lib/account-rules'
import { prisma } from '@/lib/db'
import { isDsGateway, newWfcUserId, signinCheck } from '@/lib/ds-console'
import { HttpError, route } from '@/lib/http'
import { logger } from '@/lib/logger'

const body = z.union([
  // Before a sign-in request reaches nas: may it?
  z.object({ user: z.string().max(40), action: z.string().max(20), wfcUserId: z.string().max(20).optional() }),
  // nas created a WFC account for this DS: give it our ID and bind it to the account.
  z.object({ user: z.string().max(40), allocate: z.literal(true) }),
])

/** FR-39: the DS gateway asks before each sign-in, and gets new WFC IDs here (ds-gateway/gateway.py). */
export const POST = route(async (req: Request) => {
  if (!isDsGateway(req)) throw new HttpError(401, 'unauthenticated')
  const parsed = body.safeParse(await req.json())
  if (!parsed.success) throw new HttpError(400, 'invalid')
  const input = parsed.data
  const user = await prisma.user.findUnique({ where: { id: input.user }, include: { dsConsole: true } })
  if (!user || accountBlock(user)) {
    logger.info({ user: input.user }, 'ds.signin refused: account')
    return NextResponse.json({ allow: false, reason: 'account' })
  }
  if ('allocate' in input) {
    for (let attempt = 0; ; attempt++) {
      const wfcUserId = newWfcUserId()
      try {
        await prisma.dsConsole.upsert({ where: { userId: user.id }, create: { userId: user.id, wfcUserId }, update: { wfcUserId } })
        logger.info({ user: user.id, wfcUserId }, 'ds.signin bound')
        return NextResponse.json({ wfcUserId })
      } catch (e) {
        // 2^43 IDs: a clash is rare, two in a row means something else is wrong
        if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') || attempt === 2) throw e
      }
    }
  }
  const check = signinCheck(user.dsConsole?.wfcUserId, input.action, input.wfcUserId)
  logger.info({ user: user.id, action: input.action, wfcUserId: input.wfcUserId, ...check }, 'ds.signin')
  return NextResponse.json(check)
})
