import { randomInt } from 'crypto'

/** 12 random digits as 0000-0000-0000 (FR-03). Uniqueness is enforced by the DB. */
export function newFriendCode(): string {
  const digits = Array.from({ length: 12 }, () => randomInt(10)).join('')
  return `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}`
}

export function normaliseFriendCode(input: string): string | null {
  const digits = input.replace(/\D/g, '')
  return digits.length === 12 ? `${digits.slice(0, 4)}-${digits.slice(4, 8)}-${digits.slice(8)}` : null
}
