/**
 * Trade worker (Phase 2) + housekeeping. Same codebase as the web app, separate
 * process: `npm run dev:worker`.
 */
try {
  ;(process as unknown as { loadEnvFile: (p?: string) => void }).loadEnvFile()
} catch {
  /* .env optional */
}

import { Queue, Worker } from 'bullmq'
import { env } from '@/lib/env'
import { expireLobbies } from '@/lib/link-sessions'
import { logger } from '@/lib/logger'
import { purgeDeletedSlots } from '@/lib/slot-purge'
import { sweepTrades } from '@/lib/trade-sweeper'

const connection = { url: env().REDIS_URL, maxRetriesPerRequest: null }

export const TRADES_QUEUE = 'trades'
const MAINTENANCE_QUEUE = 'maintenance'

async function main() {
  // Phase 2: fetch both base saves → save service /trade → re-parse and verify →
  // write blobs to new keys → one commit transaction (ADR-005, docs/design.md).
  new Worker(
    TRADES_QUEUE,
    async (job) => {
      logger.warn({ jobId: job.id }, 'trade jobs arrive in phase 2')
      throw new Error('not_implemented')
    },
    { connection },
  )

  const maintenance = new Queue(MAINTENANCE_QUEUE, { connection })
  await maintenance.upsertJobScheduler('sweep-trades', { every: 60_000 }, { name: 'sweep-trades' })
  await maintenance.upsertJobScheduler('purge-slots', { every: 3600_000 }, { name: 'purge-slots' })
  await maintenance.upsertJobScheduler('expire-link-lobbies', { every: 600_000 }, { name: 'expire-link-lobbies' })
  new Worker(
    MAINTENANCE_QUEUE,
    async (job) => {
      if (job.name === 'sweep-trades') {
        const result = await sweepTrades()
        if (result.expired || result.failed) logger.info(result, 'swept trades')
      } else if (job.name === 'purge-slots') {
        const result = await purgeDeletedSlots()
        if (result.purged || result.skipped || result.blobErrors) logger.info(result, 'purged deleted slots')
      } else if (job.name === 'expire-link-lobbies') {
        const expired = await expireLobbies()
        if (expired) logger.info({ expired }, 'closed unstarted link lobbies')
      }
    },
    { connection },
  )

  logger.info('worker ready')
}

main().catch((e) => {
  logger.error(e)
  process.exit(1)
})
