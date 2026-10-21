import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { accountBlock } from '@/lib/account-rules'
import { clientIp } from '@/lib/client-ip'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/password'
import { rateLimit } from '@/lib/rate-limit'

/** signIn() reports a thrown message as `error`; the login page shows it as-is. */
const LOGIN_RATE_LIMITED = 'Too many login attempts. Wait a minute and try again.'

/**
 * next-auth config (Stork pattern): credentials, JWT in an httpOnly cookie.
 * The JWT carries token_version; lib/session.ts rejects it once the user's
 * version moves on (password reset, ban).
 */
export const authOptions: NextAuthOptions = {
  session: { strategy: 'jwt' },
  secret: process.env.NEXTAUTH_SECRET,
  pages: { signIn: '/login' },
  providers: [
    CredentialsProvider({
      name: 'Credentials',
      credentials: {
        login: { label: 'Username or email', type: 'text' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(credentials, req) {
        const login = (credentials?.login || '').trim().toLowerCase()
        const password = credentials?.password || ''
        const ip = clientIp(req?.headers)
        const userAgent = (req?.headers?.['user-agent'] as string) || null

        // Per IP and per account, so neither one machine nor many can grind a password.
        const allowed = (await rateLimit(`login:${ip}`, 10, 60)) && (await rateLimit(`login-user:${login}`, 20, 900))
        if (!allowed) throw new Error(LOGIN_RATE_LIMITED)

        const user = login
          ? await prisma.user.findFirst({ where: { OR: [{ username: login }, { email: login }] } })
          : null
        const ok = !!user && (await verifyPassword(user.passwordHash, password))
        // Only someone who knows the password learns that the account is blocked, and why.
        const blocked = ok && user ? accountBlock(user) : null

        await prisma.authEvent.create({
          data: {
            userId: user?.id ?? null,
            username: login,
            event: !ok ? 'login_failed' : blocked ? 'login_blocked' : 'login',
            ip,
            userAgent,
          },
        })

        if (blocked) throw new Error(blocked)
        if (!ok || !user) return null
        return { id: user.id, name: user.username, username: user.username, role: user.role, tokenVersion: user.tokenVersion }
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        const u = user as unknown as { id: string; username: string; role: string; tokenVersion: number }
        token.sub = u.id
        token.username = u.username
        token.role = u.role
        token.tokenVersion = u.tokenVersion
      }
      return token
    },
    async session({ session, token }) {
      session.user = {
        id: token.sub!,
        username: token.username!,
        role: token.role!,
        tokenVersion: token.tokenVersion ?? 0,
      }
      return session
    },
  },
  events: {
    async signOut({ token }) {
      if (token?.sub) {
        await prisma.authEvent.create({ data: { userId: token.sub, username: token.username ?? '', event: 'logout' } })
      }
    },
  },
}
