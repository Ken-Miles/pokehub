'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'

/**
 * FR-01: unverified accounts can play and sync but not add friends or trade.
 * `result` is the outcome of clicking a verification link (?verified=1|0).
 */
export function VerifyEmailBanner({ result, welcome }: { result: string | null; welcome: boolean }) {
  const [verified, setVerified] = useState<boolean | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    api<{ emailVerified: boolean }>('/api/account')
      .then((a) => setVerified(a.emailVerified))
      .catch(() => setVerified(null))
  }, [])

  async function resend() {
    setNote('')
    try {
      await api('/api/auth/verify/resend', { method: 'POST' })
      setNote('Sent — check your inbox. Older links no longer work.')
    } catch (e) {
      setNote((e as Error).message)
    }
  }

  if (result === '1' && verified) return <Box>Email verified — you can now add friends and trade.</Box>
  if (verified !== false) return null
  return (
    <Box>
      {result === '0'
        ? 'That verification link is invalid, used or expired.'
        : welcome
          ? 'Welcome! Check your email to verify your account.'
          : 'Your email is not verified yet.'}{' '}
      You can play and sync now; verify to add friends and trade.{' '}
      <button className="underline" onClick={resend}>
        Send a new link
      </button>
      {note && <span className="ml-2 text-muted">{note}</span>}
    </Box>
  )
}

function Box({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm">{children}</p>
}
