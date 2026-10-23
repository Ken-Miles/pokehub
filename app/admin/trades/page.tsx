'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'

interface LinkTrade {
  id: string
  sessionId: string
  mode: string
  fingerprint: string
  speciesName: string
  nickname: string
  level: number
  from: string | null
  fromSlotId: string
  to: string | null
  toSlotId: string
  createdAt: string
}

const MODES: Record<string, string> = { CABLE: 'Link cable', WIRELESS: 'Wireless room', NETWORK: 'Link session', SAME_DEVICE: 'Same device' }

export default function TradesPage() {
  return (
    <Suspense>
      <Trades />
    </Suspense>
  )
}

/** FR-37: every Pokémon traded in-game over a link, newest first, optionally for one player. */
function Trades() {
  const router = useRouter()
  const params = useSearchParams()
  const user = params.get('user') ?? ''
  const [trades, setTrades] = useState<LinkTrade[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function load(after: string | null) {
    setLoading(true)
    setError('')
    try {
      const q = new URLSearchParams(user ? { user } : {})
      if (after) q.set('cursor', after)
      const r = await api<{ trades: LinkTrade[]; nextCursor: string | null }>(`/api/admin/trades?${q}`)
      setTrades((prev) => (after ? [...prev, ...r.trades] : r.trades))
      setCursor(r.nextCursor)
    } catch (e) {
      setError((e as Error).message)
      if (!after) setTrades([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(null)
  }, [user])

  function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const v = String(new FormData(e.currentTarget).get('user') ?? '').trim()
    router.push(`/admin/trades${v ? `?user=${encodeURIComponent(v)}` : ''}`)
  }

  const player = (name: string | null, slotId: string) => (
    <>
      {name ? (
        <Link href={`/admin/trades?user=${name}`} className="underline">
          {name}
        </Link>
      ) : (
        <span className="text-muted">deleted user</span>
      )}{' '}
      <Link href={`/admin/audit?slot=${slotId}`} className="font-mono text-xs text-muted underline">
        slot
      </Link>
    </>
  )

  return (
    <div className="space-y-4">
      <form onSubmit={search} key={user} className="flex gap-2">
        <input
          name="user"
          defaultValue={user}
          placeholder="Username (gave or received)"
          aria-label="Username"
          className="rounded-md border border-line bg-card px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Filter</button>
      </form>
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Pokémon</th>
              <th className="px-3 py-2 font-medium">From</th>
              <th className="px-3 py-2 font-medium">To</th>
              <th className="px-3 py-2 font-medium">How</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {trades.map((t) => (
              <tr key={t.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2">{new Date(t.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {t.nickname && t.nickname !== t.speciesName ? `${t.nickname} (${t.speciesName})` : t.speciesName} · Lv {t.level}
                  <div className="font-mono text-xs text-muted" title="Registry fingerprint">
                    {t.fingerprint}
                  </div>
                </td>
                <td className="px-3 py-2">{player(t.from, t.fromSlotId)}</td>
                <td className="px-3 py-2">{player(t.to, t.toSlotId)}</td>
                <td className="px-3 py-2">
                  {MODES[t.mode] ?? t.mode}
                  <div className="font-mono text-xs text-muted">{t.sessionId}</div>
                </td>
              </tr>
            ))}
            {!loading && trades.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  No trades yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button onClick={() => load(cursor)} disabled={loading} className="rounded-md border border-line px-3 py-1.5 text-sm">
          {loading ? 'Loading…' : 'Older trades'}
        </button>
      )}
    </div>
  )
}
