import IORedis from 'ioredis'
import { env } from '@/lib/env'

const globalForRedis = globalThis as unknown as { redis?: IORedis }

/** Shared connection for rate limits. BullMQ needs maxRetriesPerRequest: null. */
export function redis(): IORedis {
  globalForRedis.redis ??= new IORedis(env().REDIS_URL, { maxRetriesPerRequest: null })
  return globalForRedis.redis
}
