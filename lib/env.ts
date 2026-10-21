import { z } from 'zod'

/** Server env, validated once. Import from server code only. */
const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  NEXTAUTH_SECRET: z.string().min(16),
  NEXTAUTH_URL: z.string().url(),
  DATABASE_URL: z.string(),
  REDIS_URL: z.string().default('redis://localhost:6379'),
  S3_ENDPOINT: z.string().url().optional(),
  S3_REGION: z.string().default('auto'),
  S3_BUCKET: z.string(),
  S3_ACCESS_KEY_ID: z.string(),
  S3_SECRET_ACCESS_KEY: z.string(),
  SAVE_SERVICE_URL: z.string().url().optional(),
  SAVE_SERVICE_SOCKET: z.string().optional(),
  // Proxies in front of the app that append to X-Forwarded-For (lib/client-ip.ts).
  TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  ALLOW_UNLISTED_ROMS: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
})

let cached: z.infer<typeof schema> | undefined

export function env() {
  cached ??= schema.parse(process.env)
  return cached
}
