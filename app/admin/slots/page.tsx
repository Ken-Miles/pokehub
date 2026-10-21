'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/client/api'

interface AdminSlot {
  id: string
  slotNumber: number
  game: string
  origin: 'NEW' | 'IMPORTED'
  trainerName: string | null
  trainerId: number | null
  currentVersion: { seq: number; createdAt: string } | null
  deletedAt: string | null
  recoverableUntil: string | null
  lockedByTradeId: string | null
}
interface Result {
  user: { id: string; username: string; status: string; createdAt: string }
  slots: AdminSlot[]
}

export default function AdminSlotsPage() {
  return (
    <Suspense>
      <AdminSlots />
    </Suspense>
  )
}

/** FR-10: a player's game slots, including deleted ones an admin can still recover. */
function AdminSlots() {
  const router = useRouter()
  const username = useSearchParams().get('user') ?? ''
  const [result, setResult] = useState<Result | null>(null)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  const load = useCallback(async () => {
    setError('')
    if (!username) return setResult(null)
    try {
      setResult(await api<Result>(`/api/admin/slots?user=${encodeURIComponent(username)}`))
    } catch (e) {
      setResult(null)
      setError((e as Error).message)
    }
  }, [username])

  useEffect(() => {
    load()
  }, [load])

  async function recover(s: AdminSlot) {
    if (!confirm(`Recover ${s.game} (${s.trainerName ?? 'no trainer yet'}) for ${result?.user.username}? This is audit-logged.`)) return
    setError('')
    setNote('')
    try {
      const r = await api<{ slotNumber: number; conflicts: number }>(`/api/admin/slots/${s.id}/recover`, { method: 'POST' })
      setNote(
        `Recovered into slot ${r.slotNumber}.` +
          (r.conflicts ? ` ${r.conflicts} Pokémon are now held by another slot too and were flagged for review.` : ''),
      )
    } catch (e) {
      setError((e as Error).message)
    }
    load()
  }

  return (
    <div className="space-y-4">
      <form
        className="flex max-w-md gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const u = String(new FormData(e.currentTarget).get('user') ?? '').trim()
          router.push(u ? `/admin/slots?user=${encodeURIComponent(u)}` : '/admin/slots')
        }}
      >
        <input
          name="user"
          key={username}
          defaultValue={username}
          placeholder="Username"
          aria-label="Username"
          className="flex-1 rounded-md border border-line bg-card px-3 py-2 text-sm"
        />
        <button className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-white">Look up</button>
      </form>
      {error && <p className="text-sm text-danger">{error}</p>}
      {note && <p className="text-sm text-muted">{note}</p>}

      {result && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            <Link href={`/u/${result.user.username}`} className="font-medium text-fg underline">
              {result.user.username}
            </Link>{' '}
            · {result.user.status.toLowerCase()} · joined {new Date(result.user.createdAt).toLocaleDateString()} ·{' '}
            <Link href={`/admin/audit?user=${result.user.username}`} className="underline">
              audit log
            </Link>
          </p>
          {result.slots.length === 0 && <p className="text-sm text-muted">No game slots.</p>}
          <ul className="divide-y divide-line rounded-xl border border-line bg-card">
            {result.slots.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <div className="space-y-0.5">
                  <div className="font-medium">
                    {s.game} <span className="text-muted">· slot {s.slotNumber}{s.origin === 'IMPORTED' && ' · imported'}</span>
                  </div>
                  <div className="text-muted">
                    {s.trainerName
                      ? `${s.trainerName} · ID ${String(s.trainerId).padStart(5, '0')}`
                      : s.currentVersion
                        ? 'No trainer name in the save'
                        : 'No save yet'}
                    {s.currentVersion && ` · version ${s.currentVersion.seq}`}
                    {s.lockedByTradeId && ' · locked by a trade'}
                  </div>
                  {s.deletedAt && (
                    <div className="text-warn">
                      Deleted {new Date(s.deletedAt).toLocaleString()}
                      {s.recoverableUntil
                        ? ` · recoverable until ${new Date(s.recoverableUntil).toLocaleDateString()}`
                        : ' · past the recovery window'}
                    </div>
                  )}
                </div>
                <div className="flex gap-3">
                  <Link href={`/admin/audit?slot=${s.id}`} className="underline">
                    Audit
                  </Link>
                  {s.recoverableUntil && (
                    <button onClick={() => recover(s)} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">
                      Recover
                    </button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
