'use client'

import Link from 'next/link'
import { signOut, useSession } from 'next-auth/react'
import { isAdmin } from '@/lib/rbac'

export function Nav() {
  const { data, status } = useSession()
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold">
          Pokémon Hub
        </Link>
        {data && <Link href="/slots">My games</Link>}
        {data && <Link href="/friends">Friends</Link>}
        {data?.user.tester && <Link href="/dropbox">Drop box</Link>}
        {data && isAdmin(data.user.role) && <Link href="/admin">Admin</Link>}
        <span className="flex-1" />
        {status === 'authenticated' ? (
          <>
            <Link href={`/u/${data.user.username}`} className="text-muted">
              {data.user.username}
            </Link>
            <button onClick={() => signOut({ callbackUrl: '/' })}>Log out</button>
          </>
        ) : (
          status === 'unauthenticated' && (
            <>
              <Link href="/login">Log in</Link>
              <Link href="/register" className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">
                Sign up
              </Link>
            </>
          )
        )}
      </nav>
    </header>
  )
}
