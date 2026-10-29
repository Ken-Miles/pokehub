import { beforeEach, describe, expect, it, vi } from 'vitest'

// Resend's free plan (100/day, 3,000/month) is the hard ceiling: the mailer must
// stop before either cap, and a failed send must not use up the budget.
const counts = new Map<string, number>()
vi.mock('@/lib/redis', () => ({
  redis: () => ({
    incr: async (k: string) => {
      counts.set(k, (counts.get(k) ?? 0) + 1)
      return counts.get(k)
    },
    decr: async (k: string) => {
      counts.set(k, (counts.get(k) ?? 0) - 1)
      return counts.get(k)
    },
    expire: async () => 1,
    mget: async (...keys: string[]) => keys.map((k) => counts.get(k) ?? null),
  }),
}))

async function load(env: Record<string, string>) {
  vi.resetModules()
  for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v)
  return import('@/lib/mailer')
}

describe('mailer budget and Resend', () => {
  beforeEach(() => {
    counts.clear()
    vi.unstubAllEnvs()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })))
  })

  it('sends through Resend from the noreply address', async () => {
    const m = await load({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', NEXTAUTH_SECRET: 'x'.repeat(20), NEXTAUTH_URL: 'https://pktrade.aidenpearce.space', DATABASE_URL: 'postgresql://x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' })
    await m.sendMail('ann@example.com', 'Verify', 'link')
    const [url, init] = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.resend.com/emails')
    expect(JSON.parse(init.body)).toMatchObject({ from: 'Pokémon Hub <noreply@pktrade.aidenpearce.space>', to: ['ann@example.com'], subject: 'Verify' })
  })

  it('refuses when the daily cap is reached, and counts only real sends', async () => {
    const m = await load({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', MAIL_DAILY_LIMIT: '2', NEXTAUTH_SECRET: 'x'.repeat(20), NEXTAUTH_URL: 'https://p.test', DATABASE_URL: 'postgresql://x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' })
    await m.sendMail('a@example.com', 's', 't')
    await m.sendMail('b@example.com', 's', 't')
    expect(await m.mailBudgetLeft()).toBe(false)
    await expect(m.sendMail('c@example.com', 's', 't')).rejects.toBeInstanceOf(m.MailUnavailable)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('gives the budget back when the provider fails', async () => {
    const m = await load({ NODE_ENV: 'production', RESEND_API_KEY: 're_test', NEXTAUTH_SECRET: 'x'.repeat(20), NEXTAUTH_URL: 'https://p.test', DATABASE_URL: 'postgresql://x', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 'b' })
    vi.mocked(fetch).mockResolvedValueOnce(new Response('nope', { status: 500 }))
    await expect(m.sendMail('a@example.com', 's', 't')).rejects.toThrow('500')
    expect(await m.mailBudgetLeft()).toBe(true)
    expect([...counts.values()].every((v) => v === 0)).toBe(true)
  })
})
