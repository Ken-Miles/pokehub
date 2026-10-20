'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { forgetRom, inspectRom, rememberRom, rememberedRom } from '@/lib/client/rom'

type Phase = 'need-rom' | 'loading' | 'playing' | 'stale' | 'locked' | 'error'
type Sync = 'synced' | 'syncing' | 'offline' | 'flagged'

interface Props {
  slotId: string
  gameCode: string
  gameName: string
  emulatorData: string
}

/**
 * Hosts the emulator iframe (ADR-009) and keeps the slot's cloud save in sync
 * (FR-08). Every upload names the version it was built on; a 409 means this tab
 * is stale (another tab, a trade or a restore) and the emulator stops (ADR-006).
 */
export function Player({ slotId, gameCode, gameName, emulatorData }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const rom = useRef<ArrayBuffer | null>(null)
  const save = useRef<ArrayBuffer | null>(null)
  const versionId = useRef<string>('none')
  const mine = useRef(new Set<string>())
  const uploading = useRef<Promise<void>>(Promise.resolve())
  const [phase, setPhase] = useState<Phase>('need-rom')
  const [sync, setSync] = useState<Sync>('synced')
  const [error, setError] = useState('')
  const [remember, setRemember] = useState(true)

  const send = (msg: object, transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage(msg, location.origin, transfer)

  const stop = useCallback((next: Phase) => {
    send({ type: 'pause' })
    setPhase(next)
  }, [])

  const start = useCallback(async (bytes: ArrayBuffer) => {
    setPhase('loading')
    const res = await fetch(`/api/slots/${slotId}/saves/current`, { cache: 'no-store' })
    if (!res.ok) {
      setError('Could not load your cloud save.')
      return setPhase('error')
    }
    versionId.current = res.headers.get('x-version-id') ?? 'none'
    save.current = res.status === 204 ? null : await res.arrayBuffer()
    rom.current = bytes
    if (res.headers.get('x-locked') === '1') return setPhase('locked')
    setPhase('playing')
  }, [slotId])

  // Try a remembered game file first (FR-04).
  useEffect(() => {
    rememberedRom(gameCode).then((bytes) => bytes && start(bytes))
  }, [gameCode, start])

  async function pick(file: File) {
    setError('')
    try {
      const inspected = await inspectRom(file)
      if (inspected.code !== gameCode) {
        throw new Error(`This slot is for ${gameName} (${gameCode}); that file is ${inspected.game.name} (${inspected.code}).`)
      }
      const check = await fetch('/api/games/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: inspected.code, sha1: inspected.sha1 }),
      })
      if (!check.ok) throw new Error((await check.json()).message)
      if (remember) await rememberRom(gameCode, inspected.bytes)
      await start(inspected.bytes)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const upload = useCallback(
    (bytes: ArrayBuffer) => {
      uploading.current = uploading.current.then(async () => {
        setSync('syncing')
        try {
          const res = await fetch(`/api/slots/${slotId}/saves`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream', 'x-parent-version': versionId.current },
            body: bytes,
          })
          if (res.status === 409) return stop('stale')
          if (res.status === 423) return stop('locked')
          if (!res.ok) throw new Error(String(res.status))
          const body = await res.json()
          versionId.current = body.versionId
          mine.current.add(body.versionId)
          setSync(body.flagged ? 'flagged' : 'synced')
        } catch {
          setSync('offline') // the next in-game save retries with the same parent
        }
      })
    },
    [slotId, stop],
  )

  // Messages from the emulator iframe.
  useEffect(() => {
    if (phase !== 'playing') return
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return
      if (e.data?.type === 'ready' && rom.current) {
        const romCopy = rom.current.slice(0)
        const saveCopy = save.current ? save.current.slice(0) : null
        send({ type: 'boot', rom: romCopy, save: saveCopy, core: 'gba', data: emulatorData }, saveCopy ? [romCopy, saveCopy] : [romCopy])
      } else if (e.data?.type === 'save') {
        upload(e.data.bytes)
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [phase, emulatorData, upload])

  // Another tab, a restore or (later) a trade moved this slot on: stop before we overwrite it.
  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    socket.on('slot:updated', async (ev: { slotId: string; versionId: string }) => {
      if (ev.slotId !== slotId) return
      await uploading.current
      if (!mine.current.has(ev.versionId) && ev.versionId !== versionId.current) stop('stale')
    })
    return () => {
      socket.disconnect()
    }
  }, [slotId, stop])

  if (phase === 'need-rom' || phase === 'error') {
    return (
      <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-line bg-card p-6">
        <h2 className="text-lg font-semibold">Load your copy of {gameName}</h2>
        <p className="text-sm text-muted">
          Choose a backup of a game you own. It stays on this device and is never uploaded — only your save file is
          synced.
        </p>
        <input
          type="file"
          accept=".gba"
          onChange={(e) => e.target.files?.[0] && pick(e.target.files[0])}
          className="block w-full text-sm"
        />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this game on this device
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between text-sm">
        <SyncBadge sync={sync} />
        <button className="text-muted underline" onClick={() => forgetRom(gameCode).then(() => location.reload())}>
          Forget game file on this device
        </button>
      </div>
      {phase === 'stale' && (
        <Banner>
          Your save changed somewhere else (another tab, a restore or a trade).{' '}
          <button className="underline" onClick={() => location.reload()}>
            Reload to continue
          </button>
          .
        </Banner>
      )}
      {phase === 'locked' && <Banner>This save is locked while a trade finishes. It will unlock in a moment.</Banner>}
      {phase === 'loading' && <p className="text-muted">Loading your cloud save…</p>}
      {(phase === 'playing' || phase === 'stale') && (
        <iframe
          ref={frame}
          src="/emulator/index.html"
          title={gameName}
          allow="fullscreen; gamepad; autoplay"
          className="aspect-[3/2] w-full rounded-xl border border-line bg-black"
        />
      )}
    </div>
  )
}

function SyncBadge({ sync }: { sync: Sync }) {
  const label = {
    synced: 'Saved to cloud',
    syncing: 'Syncing…',
    offline: 'Offline — will retry on next save',
    flagged: 'Saved — some Pokémon flagged for review',
  }[sync]
  return <span className={sync === 'offline' || sync === 'flagged' ? 'text-warn' : 'text-muted'}>{label}</span>
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-warn bg-warn/10 px-4 py-3 text-sm">{children}</div>
}
