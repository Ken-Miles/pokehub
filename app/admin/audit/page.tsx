'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'

interface AuditEvent {
  id: string
  actor: string | null
  actorId: string | null
  action: string
  targetType: string
  targetId: string
  payload: unknown
  createdAt: string
}

const FILTERS = [
  ['user', 'Username'],
  ['slot', 'Slot id'],
  ['trade', 'Trade id'],
  ['action', 'Action starts with (e.g. save., admin.)'],
] as const

export default function AuditPage() {
  return (
    <Suspense>
      <Audit />
    </Suspense>
  )
}

/** FR-24: the append-only audit log, newest first, filtered by user, slot, trade or action. */
function Audit() {
  const router = useRouter()
  const params = useSearchParams()
  const query = new URLSearchParams(FILTERS.flatMap(([k]) => (params.get(k) ? [[k, params.get(k)!]] : [])))
  const queryString = query.toString()
  const [events, setEvents] = useState<AuditEvent[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)

  async function load(after: string | null) {
    setLoading(true)
    setError('')
    try {
      const q = new URLSearchParams(queryString)
      if (after) q.set('cursor', after)
      const r = await api<{ events: AuditEvent[]; nextCursor: string | null }>(`/api/admin/audit?${q}`)
      setEvents((prev) => (after ? [...prev, ...r.events] : r.events))
      setCursor(r.nextCursor)
    } catch (e) {
      setError((e as Error).message)
      if (!after) setEvents([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load(null)
  }, [queryString])

  function search(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const form = new FormData(e.currentTarget)
    const q = new URLSearchParams()
    for (const [k] of FILTERS) {
      const v = String(form.get(k) ?? '').trim()
      if (v) q.set(k, v)
    }
    router.push(`/admin/audit${q.size ? `?${q}` : ''}`)
  }

  return (
    <div className="space-y-4">
      <form onSubmit={search} key={queryString} className="grid gap-2 sm:grid-cols-5">
        {FILTERS.map(([k, label]) => (
          <input
            key={k}
            name={k}
            defaultValue={params.get(k) ?? ''}
            placeholder={label}
            aria-label={label}
            className="rounded-md border border-line bg-card px-3 py-2 text-sm"
          />
        ))}
        <button className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Filter</button>
      </form>
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="overflow-x-auto rounded-xl border border-line bg-card">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-line text-muted">
            <tr>
              <th className="px-3 py-2 font-medium">When</th>
              <th className="px-3 py-2 font-medium">Who</th>
              <th className="px-3 py-2 font-medium">Action</th>
              <th className="px-3 py-2 font-medium">Target</th>
              <th className="px-3 py-2 font-medium">Details</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {events.map((e) => (
              <tr key={e.id} className="align-top">
                <td className="whitespace-nowrap px-3 py-2">{new Date(e.createdAt).toLocaleString()}</td>
                <td className="px-3 py-2">
                  {e.actor ? (
                    <Link href={`/admin/audit?user=${e.actor}`} className="underline">
                      {e.actor}
                    </Link>
                  ) : (
                    <span className="text-muted">{e.actorId ? 'deleted user' : 'system'}</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2 font-mono">{e.action}</td>
                <td className="px-3 py-2">
                  {e.targetType === 'slot' || e.targetType === 'trade' ? (
                    <Link href={`/admin/audit?${e.targetType}=${e.targetId}`} className="font-mono underline">
                      {e.targetType}:{e.targetId}
                    </Link>
                  ) : (
                    <span className="font-mono">
                      {e.targetType}:{e.targetId}
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 font-mono text-xs text-muted">{e.payload ? JSON.stringify(e.payload) : ''}</td>
              </tr>
            ))}
            {!loading && events.length === 0 && !error && (
              <tr>
                <td colSpan={5} className="px-3 py-6 text-center text-muted">
                  No events match.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {cursor && (
        <button onClick={() => load(cursor)} disabled={loading} className="rounded-md border border-line px-3 py-1.5 text-sm">
          {loading ? 'Loading…' : 'Older events'}
        </button>
      )}
    </div>
  )
}
