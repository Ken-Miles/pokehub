'use client'

import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import { api, formatPlayTime } from '@/lib/client/api'
import { inspectRom, rememberRom } from '@/lib/client/rom'

interface Slot {
  id: string
  slotNumber: number
  origin: 'NEW' | 'IMPORTED'
  trainerName: string | null
  trainerId: number | null
  game: { name: string; region: string | null } | null
  currentVersion: { playSeconds: number; createdAt: string } | null
}

export default function SlotsPage() {
  return (
    <Suspense>
      <Slots />
    </Suspense>
  )
}

function Slots() {
  const router = useRouter()
  const params = useSearchParams()
  const [slots, setSlots] = useState<Slot[] | null>(null)
  const [max, setMax] = useState(3)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  const load = () =>
    api<{ slots: Slot[]; max: number }>('/api/slots')
      .then((r) => {
        setSlots(r.slots)
        setMax(r.max)
      })
      .catch((e) => (e.status === 401 ? router.push('/login') : setError(e.message)))

  useEffect(() => {
    load()
  }, [])

  /** New game or import (FR-10, FR-25). The game file is inspected locally; only code + hash go up. */
  async function create(origin: 'NEW' | 'IMPORTED', romFile: File, saveFile?: File) {
    setBusy(true)
    setError('')
    try {
      const rom = await inspectRom(romFile)
      const { slot } = await api<{ slot: { id: string } }>('/api/slots', {
        method: 'POST',
        body: JSON.stringify({ platform: rom.platform, code: rom.code, sha1: rom.sha1, origin }),
      })
      await rememberRom(rom.code, rom.bytes)
      if (origin === 'IMPORTED' && saveFile) {
        await api(`/api/slots/${slot.id}/import`, { method: 'POST', body: await saveFile.arrayBuffer() })
      }
      router.push(`/play/${slot.id}`)
    } catch (e) {
      setError((e as Error).message)
      load()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-8">
      {params.get('welcome') && (
        <p className="rounded-lg border border-line bg-card px-4 py-3 text-sm">
          Welcome! Check your email to verify your account — you'll need that to trade.
        </p>
      )}
      <h1 className="text-2xl font-semibold">My games</h1>
      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="grid gap-4 sm:grid-cols-3">
        {slots?.map((s) => (
          <div key={s.id} className="space-y-2 rounded-xl border border-line bg-card p-4">
            <div className="text-xs text-muted">Slot {s.slotNumber}{s.origin === 'IMPORTED' && ' · imported'}</div>
            <div className="text-lg font-semibold">{s.game?.name}</div>
            <div className="text-sm text-muted">
              {s.trainerName ? `${s.trainerName} · ID ${String(s.trainerId).padStart(5, '0')}` : 'Not saved yet'}
              {s.currentVersion && ` · ${formatPlayTime(s.currentVersion.playSeconds)}`}
            </div>
            <div className="flex gap-3 pt-2 text-sm">
              <Link href={`/play/${s.id}`} className="rounded-md bg-accent px-3 py-1.5 font-medium text-white">
                Play
              </Link>
              <Link href={`/slots/${s.id}`} className="rounded-md border border-line px-3 py-1.5">
                Saves
              </Link>
            </div>
          </div>
        ))}
      </div>

      {slots && slots.length < max && <NewSlot busy={busy} onCreate={create} />}
    </div>
  )
}

function NewSlot({ busy, onCreate }: { busy: boolean; onCreate: (o: 'NEW' | 'IMPORTED', rom: File, save?: File) => void }) {
  const [mode, setMode] = useState<'NEW' | 'IMPORTED'>('NEW')
  const [rom, setRom] = useState<File>()
  const [save, setSave] = useState<File>()
  return (
    <div className="max-w-xl space-y-4 rounded-xl border border-line bg-card p-6">
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'NEW'} onChange={() => setMode('NEW')} /> Start a new game
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" checked={mode === 'IMPORTED'} onChange={() => setMode('IMPORTED')} /> Import an existing save
        </label>
      </div>
      <label className="block space-y-1 text-sm">
        <span>Your game backup (.gba) — stays on this device</span>
        <input type="file" accept=".gba" onChange={(e) => setRom(e.target.files?.[0])} className="block w-full" />
      </label>
      {mode === 'IMPORTED' && (
        <label className="block space-y-1 text-sm">
          <span>Save file (.sav) — imported Pokémon start unverified</span>
          <input type="file" accept=".sav,.srm" onChange={(e) => setSave(e.target.files?.[0])} className="block w-full" />
        </label>
      )}
      <button
        disabled={busy || !rom || (mode === 'IMPORTED' && !save)}
        onClick={() => rom && onCreate(mode, rom, save)}
        className="rounded-md bg-accent px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Setting up…' : mode === 'NEW' ? 'Create slot and play' : 'Import and play'}
      </button>
    </div>
  )
}
