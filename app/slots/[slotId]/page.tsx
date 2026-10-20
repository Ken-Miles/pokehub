'use client'

import { useParams, useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'
import { api, formatPlayTime } from '@/lib/client/api'

interface Version {
  id: string
  seq: number
  source: string
  playSeconds: number
  createdAt: string
  current: boolean
  restorable: boolean
}

interface Detail {
  slot: { id: string; trainerName: string | null; lastTradeVersionId: string | null; game: { name: string } }
  versions: Version[]
}

/** FR-09 save history + restore. Versions before the last trade are locked (ADR-007). */
export default function SlotDetailPage() {
  const { slotId } = useParams<{ slotId: string }>()
  const router = useRouter()
  const [detail, setDetail] = useState<Detail>()
  const [error, setError] = useState('')
  const [confirmName, setConfirmName] = useState('')

  const load = () => api<Detail>(`/api/slots/${slotId}`).then(setDetail).catch((e) => setError(e.message))
  useEffect(() => {
    load()
  }, [slotId])

  async function restore(versionId: string) {
    setError('')
    try {
      await api(`/api/slots/${slotId}/restore`, { method: 'POST', body: JSON.stringify({ versionId }) })
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  async function remove() {
    try {
      await api(`/api/slots/${slotId}`, { method: 'DELETE', body: JSON.stringify({ confirmTrainerName: confirmName }) })
      router.push('/slots')
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (!detail) return <p className="text-muted">{error || 'Loading…'}</p>

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">
        {detail.slot.game.name} <span className="text-muted">· save history</span>
      </h1>
      {error && <p className="text-sm text-danger">{error}</p>}

      <table className="w-full text-sm">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-2">#</th>
            <th>When</th>
            <th>Source</th>
            <th>Play time</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {detail.versions.map((v) => (
            <tr key={v.id} className="border-t border-line">
              <td className="py-2">{v.seq}</td>
              <td>{new Date(v.createdAt).toLocaleString()}</td>
              <td className="lowercase">{v.source}</td>
              <td>{formatPlayTime(v.playSeconds)}</td>
              <td className="text-right">
                {v.current ? (
                  <span className="text-muted">current</span>
                ) : v.restorable ? (
                  <button className="underline" onClick={() => restore(v.id)}>
                    Restore
                  </button>
                ) : (
                  <span className="text-muted" title="You can't restore a save from before a trade.">
                    before a trade
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="max-w-md space-y-2 rounded-xl border border-line bg-card p-4 text-sm">
        <div className="font-medium">Delete this slot</div>
        <p className="text-muted">Type the trainer name ({detail.slot.trainerName ?? 'blank'}) to confirm.</p>
        <input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} className="w-full rounded-md border border-line bg-bg px-3 py-2" />
        <button onClick={remove} className="rounded-md border border-danger px-3 py-1.5 text-danger">
          Delete slot
        </button>
      </div>
    </div>
  )
}
