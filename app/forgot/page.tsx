'use client'

import { useState } from 'react'
import { api } from '@/lib/client/api'

/** FR-01: ask for a reset link. The answer is the same whether or not the email exists. */
export default function ForgotPage() {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState('')

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setError('')
    try {
      await api('/api/auth/reset', { method: 'POST', body: JSON.stringify({ email: new FormData(e.currentTarget).get('email') }) })
      setSent(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  if (sent) {
    return (
      <div className="mx-auto max-w-sm space-y-4">
        <h1 className="text-2xl font-semibold">Check your email</h1>
        <p className="text-sm text-muted">If that address has an account, a reset link is on its way. It works for 1 hour.</p>
      </div>
    )
  }

  return (
    <form onSubmit={onSubmit} className="mx-auto max-w-sm space-y-4">
      <h1 className="text-2xl font-semibold">Reset your password</h1>
      <input name="email" type="email" placeholder="Email" autoComplete="email" required className="w-full rounded-md border border-line bg-card px-3 py-2" />
      {error && <p className="text-sm text-danger">{error}</p>}
      <button className="w-full rounded-md bg-accent px-3 py-2 font-medium text-white">Send reset link</button>
    </form>
  )
}
