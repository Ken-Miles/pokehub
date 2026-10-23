import { createHash, timingSafeEqual } from 'crypto'
import type { User } from '@prisma/client'
import { accountBlock } from '@/lib/account-rules'
import { prisma } from '@/lib/db'
import { env } from '@/lib/env'

/** Headers the bot host (bots/, ADR-023) sends on API calls; the socket sends the same in its auth. */
export const BOT_KEY_HEADER = 'x-bot-key'
/** The bot's username, e.g. bot5. */
export const BOT_ID_HEADER = 'x-bot'

const digest = (s: string) => createHash('sha256').update(s).digest()

/**
 * The bot the bot host is acting as (FR-36), or null. Only `isBot` accounts, only
 * with BOT_HOST_SECRET; a player's account can never be reached this way.
 */
export async function botUser(key: unknown, bot: unknown): Promise<User | null> {
  const secret = env().BOT_HOST_SECRET
  if (!secret || typeof key !== 'string' || typeof bot !== 'string' || bot.length > 40) return null
  if (!timingSafeEqual(digest(key), digest(secret))) return null
  const user = await prisma.user.findUnique({ where: { username: bot } })
  return user?.isBot && !accountBlock(user) ? user : null
}
