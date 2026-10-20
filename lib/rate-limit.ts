import { redis } from '@/lib/redis'

/**
 * Fixed-window rate limit (NFR-05). Returns true when the call is allowed.
 * Keys: `login:<ip>`, `upload:<userId>`, `trade:<userId>` …
 */
export async function rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
  const bucket = `rl:${key}:${Math.floor(Date.now() / 1000 / windowSeconds)}`
  const count = await redis().incr(bucket)
  if (count === 1) await redis().expire(bucket, windowSeconds)
  return count <= limit
}
