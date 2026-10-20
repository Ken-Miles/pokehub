import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { saveService } from '@/lib/save-service'

export async function GET() {
  const [db, saves] = await Promise.allSettled([prisma.$queryRaw`SELECT 1`, saveService.health()])
  const ok = db.status === 'fulfilled' && saves.status === 'fulfilled'
  return NextResponse.json(
    { ok, db: db.status === 'fulfilled', saveService: saves.status === 'fulfilled' ? saves.value : false },
    { status: ok ? 200 : 503 },
  )
}
