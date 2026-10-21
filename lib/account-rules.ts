import { z } from 'zod'
import type { EmailTokenKind, UserStatus } from '@prisma/client'

/**
 * Pure account rules (FR-01), kept free of I/O like lib/save-rules.ts so they
 * are unit-tested (tests/account-rules.test.ts).
 */

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9_]{3,20}$/, 'Username: 3–20 letters, numbers or _')

export const emailSchema = z.string().trim().toLowerCase().email('Enter a valid email address.')

export const passwordSchema = z.string().min(10, 'Password: at least 10 characters').max(200)

/** How long each emailed link stays valid. */
export const TOKEN_TTL_MS: Record<EmailTokenKind, number> = {
  VERIFY_EMAIL: 24 * 3600 * 1000,
  RESET_PASSWORD: 3600 * 1000,
}

export interface AccountState {
  status: UserStatus
  statusReason: string | null
  suspendedUntil: Date | null
}

/**
 * Why this account may not sign in, or null if it may. A suspension whose end
 * has passed no longer blocks. Only shown after the password checks out, so it
 * never tells a stranger whether an account is banned.
 */
export function accountBlock(user: AccountState, now = new Date()): string | null {
  if (user.status === 'ACTIVE') return null
  if (user.status === 'SUSPENDED' && user.suspendedUntil && user.suspendedUntil <= now) return null
  const reason = user.statusReason ? ` Reason: ${user.statusReason}` : ''
  if (user.status === 'BANNED') return `This account is banned.${reason}`
  const until = user.suspendedUntil ? ` until ${user.suspendedUntil.toISOString().slice(0, 10)}` : ''
  return `This account is suspended${until}.${reason}`
}

export interface EmailTokenState {
  kind: EmailTokenKind
  usedAt: Date | null
  expiresAt: Date
}

/** Emailed links are single-use and expire (FR-01). */
export function emailTokenProblem(
  row: EmailTokenState | null,
  kind: EmailTokenKind,
  now = new Date(),
): 'invalid' | 'used' | 'expired' | null {
  if (!row || row.kind !== kind) return 'invalid'
  if (row.usedAt) return 'used'
  if (row.expiresAt <= now) return 'expired'
  return null
}
