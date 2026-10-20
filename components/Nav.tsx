'use client'

import Link from 'next/link'
import { signOut, useSession } from 'next-auth/react'

export function Nav() {
  const { data, status } = useSession()
  return (
    <header className="border-b border-line">
      <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3 text-sm">
        <Link href="/" className="font-semibold">
          Pokémon Hub
        </Link>
        {data && <Link href="/slots">My games</Link>}
        <span className="flex-1" />
        {status === 'authenticated' ? (
          <>
            <span className="text-muted">{data.user.username}</span>
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
