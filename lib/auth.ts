import type { NextAuthOptions } from 'next-auth'
import CredentialsProvider from 'next-auth/providers/credentials'
import { prisma } from '@/lib/db'
import { verifyPassword } from '@/lib/password'
import { rateLimit } from '@/lib/rate-limit'

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
        const ip =
          (req?.headers?.['x-forwarded-for'] as string)?.split(',')[0]?.trim() ||
          (req?.headers?.['x-real-ip'] as string) ||
          null
        const userAgent = (req?.headers?.['user-agent'] as string) || null

        if (!(await rateLimit(`login:${ip ?? 'unknown'}`, 10, 60))) return null

        const user = login
          ? await prisma.user.findFirst({ where: { OR: [{ username: login }, { email: login }] } })
          : null
        const ok = !!user && user.status === 'ACTIVE' && (await verifyPassword(user.passwordHash, password))

        await prisma.authEvent.create({
          data: { userId: user?.id ?? null, username: login, event: ok ? 'login' : 'login_failed', ip, userAgent },
        })

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
