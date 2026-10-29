'use client'

import { useEffect, useState } from 'react'
import { api } from '@/lib/client/api'

/**
 * FR-01: unverified accounts can play and sync but not add friends or trade.
 * `result` is the outcome of clicking a verification link (?verified=1|0).
 */
export function VerifyEmailBanner({ result, welcome }: { result: string | null; welcome: boolean }) {
  const [verified, setVerified] = useState<boolean | null>(null)

  useEffect(() => {
    api<{ emailVerified: boolean }>('/api/account')
      .then((a) => setVerified(a.emailVerified))
      .catch(() => setVerified(null))
  }, [])

  if (result === '1' && verified) return <Box>Email verified — you can now add friends and trade.</Box>
  if (verified !== false) return null
  return (
    <Box>
      {result === '0'
        ? 'That verification link is invalid, used or expired. There is no resend yet, so this account can only play and sync.'
        : welcome
          ? 'Welcome! We emailed you a verification link (from noreply@pokehub.aidenpearce.space). Check your spam folder too.'
          : 'Your email is not verified yet.'}{' '}
      You can play and sync now; verify to add friends and trade.
    </Box>
  )
}

function Box({ children }: { children: React.ReactNode }) {
  return <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm">{children}</p>
}
