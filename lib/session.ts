import { getServerSession } from 'next-auth'
import { headers } from 'next/headers'
import type { Role, User } from '@prisma/client'
import { accountBlock } from '@/lib/account-rules'
import { authOptions } from '@/lib/auth'
import { BOT_ID_HEADER, BOT_KEY_HEADER, botUser } from '@/lib/bot-auth'
import { prisma } from '@/lib/db'
import { HttpError } from '@/lib/http'
import { roleAtLeast } from '@/lib/rbac'

/**
 * The signed-in user, re-checked against the database on every request so a ban
 * or password reset (token_version bump) takes effect immediately.
 */
export async function currentUser(): Promise<User | null> {
  // The bot host acting as a bot (FR-36). A request that claims to be a bot never falls back to a cookie.
  const h = await headers()
  if (h.has(BOT_KEY_HEADER)) return botUser(h.get(BOT_KEY_HEADER), h.get(BOT_ID_HEADER))
  const session = await getServerSession(authOptions)
  if (!session?.user?.id) return null
  const user = await prisma.user.findUnique({ where: { id: session.user.id } })
  if (!user || accountBlock(user) || user.tokenVersion !== session.user.tokenVersion) return null
  return user
}

export async function requireUser(): Promise<User> {
  const user = await currentUser()
  if (!user) throw new HttpError(401, 'unauthenticated', 'Please log in.')
  return user
}

/** For staff routes: the signed-in user, if their current role is at least `min`. */
export async function requireRole(min: Role): Promise<User> {
  const user = await requireUser()
  if (!roleAtLeast(user.role, min)) throw new HttpError(403, 'forbidden', 'You do not have access to this.')
  return user
}
