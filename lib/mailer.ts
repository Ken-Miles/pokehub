import { env } from '@/lib/env'
import { logger } from '@/lib/logger'
import { redis } from '@/lib/redis'

/** Sending is off (no key, or the free-plan budget is spent). Callers turn this into a clear error. */
export class MailUnavailable extends Error {}

const day = () => new Date().toISOString().slice(0, 10)
const month = () => day().slice(0, 7)

/** Counters for today and this month, both must stay under their limits. */
async function counters(): Promise<{ dayKey: string; monthKey: string }> {
  return { dayKey: `mail:day:${day()}`, monthKey: `mail:month:${month()}` }
}

/** True when one more email fits in today's and this month's budget. Doesn't reserve anything. */
export async function mailBudgetLeft(): Promise<boolean> {
  const { dayKey, monthKey } = await counters()
  const [d, m] = await redis().mget(dayKey, monthKey)
  const e = env()
  return Number(d ?? 0) < e.MAIL_DAILY_LIMIT && Number(m ?? 0) < e.MAIL_MONTHLY_LIMIT
}

/** Reserve one send. Throws MailUnavailable when either cap is reached. */
async function reserve(): Promise<() => Promise<void>> {
  const { dayKey, monthKey } = await counters()
  const r = redis()
  const [d, m] = [await r.incr(dayKey), await r.incr(monthKey)]
  if (d === 1) await r.expire(dayKey, 2 * 86400)
  if (m === 1) await r.expire(monthKey, 40 * 86400)
  const e = env()
  const release = async () => {
    await r.decr(dayKey)
    await r.decr(monthKey)
  }
  if (d > e.MAIL_DAILY_LIMIT || m > e.MAIL_MONTHLY_LIMIT) {
    await release()
    throw new MailUnavailable('email budget reached')
  }
  return release
}

/**
 * Send one email through Resend's HTTP API (no mail server here). In development
 * without a key the text goes to the log instead, so links can be clicked.
 * The text holds single-use links: it is never logged in production.
 */
export async function sendMail(to: string, subject: string, text: string): Promise<void> {
  const e = env()
  if (!e.RESEND_API_KEY) {
    if (e.NODE_ENV === 'production') throw new MailUnavailable('RESEND_API_KEY is not set')
    logger.info({ to, subject }, `[mail] ${text}`)
    return
  }
  const release = await reserve()
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${e.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: e.MAIL_FROM, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`mail provider answered ${res.status}`)
  } catch (err) {
    await release() // a failed send doesn't use up the budget
    throw err
  }
}
