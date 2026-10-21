'use client'

import { useState } from 'react'
import { api } from '@/lib/client/api'

/** FR-03 from a profile (FR-02): the friends API decides; this shows its answer. */
export function AddFriendButton({ username }: { username: string }) {
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  async function add() {
    setBusy(true)
    try {
      const r = await api<{ result: string }>('/api/friends', { method: 'POST', body: JSON.stringify({ to: username }) })
      setMessage(r.result === 'accepted' ? 'You are now friends.' : 'Friend request sent.')
    } catch (e) {
      setMessage((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  if (message) return <p className="text-sm text-muted">{message}</p>
  return (
    <button onClick={add} disabled={busy} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
      Add friend
    </button>
  )
}
