import { randomInt } from 'crypto'

/** Friend codes starting 0000-0000 belong to test bots (FR-36): bot5 is 0000-0000-0005. */
const BOT_PREFIX = '0000-0000-'

/** 12 random digits as 0000-0000-0000 (FR-03), never a bot's. Uniqueness is enforced by the DB. */
export function newFriendCode(): string {
  for (;;) {
    const digits = Array.from({ length: 12 }, () => randomInt(10)).join('')
    const code = `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`
    if (!isBotFriendCode(code)) return code
  }
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
  return digits.length === 12 ? `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}` : null
}
