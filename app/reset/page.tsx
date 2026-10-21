'use client'

import { signOut } from 'next-auth/react'
import { useSearchParams } from 'next/navigation'
import { Suspense, useState } from 'react'
import { api } from '@/lib/client/api'

export default function ResetPage() {
  return (
    <Suspense>
      <Reset />
    </Suspense>
  )
}

/** FR-01: set a new password from the emailed link. Signs out every session. */
function Reset() {
  const token = useSearchParams().get('token') ?? ''
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    const form = new FormData(e.currentTarget)
    if (form.get('password') !== form.get('confirm')) return setError('The passwords do not match.')
    try {
      await api('/api/auth/reset/confirm', { method: 'POST', body: JSON.stringify({ token, password: form.get('password') }) })
      // The server already invalidated every session; clear this tab's cookie too.
      await signOut({ callbackUrl: '/login?reset=1' })
    } catch (err) {
      setError((err as Error).message)
    }
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Choose a new password</h1>
      <input name="password" type="password" placeholder="New password (10+ characters)" minLength={10} autoComplete="new-password" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      <input name="confirm" type="password" placeholder="Repeat new password" minLength={10} autoComplete="new-password" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white">Change password</button>
      <p className="text-sm text-muted">This signs you out on every device.</p>
    </form>
  )
}
