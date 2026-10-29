import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { saveService } from '@/lib/save-service'
import { DEPLOY_COLOR, DEPLOY_VERSION } from '@/lib/deploy'

/** `activeLinks` lets a deploy wait until this colour has no live link sessions before it stops it. */
export async function GET() {
  const [db, saves, links] = await Promise.allSettled([
    prisma.$queryRaw`SELECT 1`,
    saveService.health(),
    prisma.linkSession.count({ where: { state: 'ACTIVE', relayOwner: DEPLOY_COLOR } }),
  ])
  const ok = db.status === 'fulfilled' && saves.status === 'fulfilled'
  return NextResponse.json(
    {
      ok,
      db: db.status === 'fulfilled',
      saveService: saves.status === 'fulfilled' ? saves.value : false,
      color: DEPLOY_COLOR,
      version: DEPLOY_VERSION,
      activeLinks: links.status === 'fulfilled' ? links.value : null,
    },
    { status: ok ? 200 : 503 },
  )
}
