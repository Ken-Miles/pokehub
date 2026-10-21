import { getServerSession } from 'next-auth'
import type { User } from '@prisma/client'
import { accountBlock } from '@/lib/account-rules'
import { authOptions } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { HttpError } from '@/lib/http'

/**
 * The signed-in user, re-checked against the database on every request so a ban
 * or password reset (token_version bump) takes effect immediately.
 */
export async function currentUser(): Promise<User | null> {
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
