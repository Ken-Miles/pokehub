import { randomInt } from 'crypto'

/** Friend codes starting 0000-0000 belong to test bots (FR-36): bot5 is 0000-0000-0005. */
const BOT_PREFIX = '0000-0000-'

/**
 * ADR-029: a code is 8 random digits, then the join day (days since EPOCH). Each day
 * digit is added (mod 10) to random digit i, so the date can't be read off the code
 * by eye but friendCodeDay recovers it.
 */
const EPOCH = Date.UTC(2026, 0, 5) // before launch
const DAY_MS = 24 * 60 * 60 * 1000

function format(digits: string): string {
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`
}

/** 0000-0000-0000 (FR-03), never a bot's. Uniqueness (1e8 per day) is enforced by the DB. */
export function newFriendCode(now = Date.now()): string {
  // shortcut: the day wraps after 10000 days (2053); widen the field before then.
  const day = String(Math.floor((now - EPOCH) / DAY_MS) % 10000).padStart(4, '0')
  for (;;) {
    const r = Array.from({ length: 8 }, () => randomInt(10))
    const code = format(r.join('') + [...day].map((c, i) => (Number(c) + r[i]) % 10).join(''))
    if (!isBotFriendCode(code)) return code
  }
}

/** The join day (0 = EPOCH) of a code made by newFriendCode. Older, fully random codes decode to noise. */
export function friendCodeDay(code: string): number {
  const d = code.replace(/\D/g, '')
  return Number([0, 1, 2, 3].map((i) => (Number(d[8 + i]) - Number(d[i]) + 10) % 10).join(''))
}

export function botFriendCode(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new Error('Bot numbers run from 1 to 9999.')
  return BOT_PREFIX + String(n).padStart(4, '0')
}

export function isBotFriendCode(code: string): boolean {
  return code.startsWith(BOT_PREFIX)
}

export function normaliseFriendCode(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  return digits.length === 12 ? format(digits) : null
}
