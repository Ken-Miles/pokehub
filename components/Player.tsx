'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { FileDrop } from '@/components/FileDrop'
import { forgetRom, inspectRom, rememberRom, rememberedRom } from '@/lib/client/rom'
import { legend, type Binding } from '@/lib/client/controls'
import { SaveSync, indexedDbQueue, romCheck, type PendingSave, type SyncStatus } from '@/lib/client/save-sync'
import type { Platform } from '@/lib/games'

type Phase = 'need-rom' | 'loading' | 'device-conflict' | 'playing' | 'stale' | 'locked' | 'error'

interface Props {
  slotId: string
  platform: Platform
  core: string
  gameCode: string
  gameName: string
  emulatorData: string
}

/**
 * Hosts the emulator iframe (ADR-009) and keeps the slot's cloud save in sync
 * (FR-08) through SaveSync: unsent saves wait in IndexedDB and are retried;
 * every upload names the version it was built on, and a 409 means this tab is
 * stale (another tab, a trade or a restore), so the emulator stops (ADR-006).
 */
export function Player({ slotId, platform, core, gameCode, gameName, emulatorData }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const rom = useRef<ArrayBuffer | null>(null)
  const bootSave = useRef<ArrayBuffer | null>(null)
  const sync = useRef<SaveSync | null>(null)
  const [phase, setPhase] = useState<Phase>('need-rom')
  const [status, setStatus] = useState<SyncStatus>({ state: 'synced', flagged: false })
  const [deviceSave, setDeviceSave] = useState<PendingSave | null>(null)
  const [error, setError] = useState('')
  const [remember, setRemember] = useState(true)
  const [bindings, setBindings] = useState<Binding[] | null>(null)
  const [fastForward, setFastForward] = useState(false)

  const send = (msg: object, transfer: Transferable[] = []) =>
    frame.current?.contentWindow?.postMessage(msg, location.origin, transfer)

  // The cloud save moved on without this tab: pause, and drop save states made
  // before that change so none can be loaded and saved over it (ADR-016).
  const stop = useCallback((next: 'stale' | 'locked') => {
    send({ type: 'pause' })
    send({ type: 'clear-states' })
    sync.current?.halt(next === 'stale' ? 'conflict' : 'locked')
    setPhase(next)
  }, [])

  // One SaveSync per slot; its status drives the badge and stops the game on 409/423.
  useEffect(() => {
    const s = new SaveSync({
      slotId,
      platform,
      queue: indexedDbQueue,
      onStatus: (st) => {
        setStatus(st)
        if (st.state === 'conflict' || st.state === 'locked') {
          send({ type: 'pause' })
          send({ type: 'clear-states' })
          setPhase((p) => (p === 'playing' ? (st.state === 'conflict' ? 'stale' : 'locked') : p))
        }
      },
    })
    sync.current = s
    const online = () => s.retryNow()
    window.addEventListener('online', online)
    return () => {
      window.removeEventListener('online', online)
      s.dispose()
    }
  }, [slotId, platform])

  const start = useCallback(
    async (bytes: ArrayBuffer) => {
      setPhase('loading')
      const res = await fetch(`/api/slots/${slotId}/saves/current`, { cache: 'no-store' })
      if (!res.ok) {
        setError('Could not load your cloud save.')
        return setPhase('error')
      }
      rom.current = bytes
      const serverSave = res.status === 204 ? null : await res.arrayBuffer()
      if (res.headers.get('x-locked') === '1') return setPhase('locked')
      const boot = await sync.current!.boot(res.headers.get('x-version-id') ?? 'none', serverSave)
      if ('conflict' in boot) {
        setDeviceSave(boot.conflict)
        return setPhase('device-conflict')
      }
      bootSave.current = boot.save
      setPhase('playing')
    },
    [slotId],
  )

  // Try a remembered game file first (FR-04).
  useEffect(() => {
    rememberedRom(gameCode).then((bytes) => bytes && start(bytes))
  }, [gameCode, start])

  async function pick(file: File) {
    setError('')
    try {
      const inspected = await inspectRom(file)
      if (inspected.platform !== platform || inspected.code !== gameCode) {
        throw new Error(`This slot is for ${gameName} (${gameCode}); that file is ${inspected.game.name} (${inspected.code}).`)
      }
      const check = await fetch('/api/games/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(romCheck(inspected)),
      })
      if (!check.ok) throw new Error((await check.json()).message)
      if (remember) await rememberRom(gameCode, inspected.bytes)
      await start(inspected.bytes)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // Messages from the emulator iframe.
  useEffect(() => {
    if (phase !== 'playing') return
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return
      if (e.data?.type === 'ready' && rom.current) {
        const romCopy = rom.current.slice(0)
        const saveCopy = bootSave.current ? bootSave.current.slice(0) : null
        send({ type: 'boot', rom: romCopy, save: saveCopy, core, data: emulatorData }, saveCopy ? [romCopy, saveCopy] : [romCopy])
      } else if (e.data?.type === 'save') {
        void sync.current?.submit(e.data.bytes)
      } else if (e.data?.type === 'controls') {
        setBindings(e.data.keys)
        setFastForward(!!e.data.fastForward)
      } else if (e.data?.type === 'unchanged') {
        void sync.current?.retryNow()
      }
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [phase, core, emulatorData])

  // Another tab, a restore or (later) a trade moved this slot on: stop before we overwrite it.
  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    socket.on('slot:updated', async (ev: { slotId: string; versionId: string }) => {
      if (ev.slotId !== slotId || !sync.current) return
      await sync.current.idle()
      if (!sync.current.owns(ev.versionId)) stop('stale')
    })
    return () => {
      socket.disconnect()
    }
  }, [slotId, stop])

  function syncNow() {
    send({ type: 'flush' })
    void sync.current?.retryNow()
  }

  async function useCloudSave() {
    await sync.current?.discardPending()
    setDeviceSave(null)
    if (rom.current) await start(rom.current)
  }

  if (phase === 'need-rom' || phase === 'error') {
    return (
      <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-line bg-card p-6">
        <h2 className="text-lg font-semibold">Load your copy of {gameName}</h2>
        <p className="text-sm text-muted">
          Choose a backup of a game you own. It stays on this device and is never uploaded — only your save file is
          synced.
        </p>
        <FileDrop label={`Your ${gameName} backup (.gba)`} accept=".gba" onFile={pick} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Remember this game on this device
        </label>
        {error && <p className="text-sm text-danger">{error}</p>}
      </div>
    )
  }

  if (phase === 'device-conflict' && deviceSave) {
    return <DeviceConflict save={deviceSave} gameCode={gameCode} onContinue={useCloudSave} />
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <div className="flex items-center gap-3">
          <SyncBadge status={status} />
          {phase === 'playing' && status.state !== 'syncing' && (
            <button className="underline" onClick={syncNow}>
              Sync now
            </button>
          )}
          {phase === 'playing' && bindings && (
            <button
              aria-pressed={fastForward}
              className={fastForward ? 'rounded-md bg-accent px-2 py-0.5 font-medium text-white' : 'underline'}
              onClick={() => send({ type: 'fast-forward', on: !fastForward })}
            >
              Fast-forward {fastForward ? 'on' : 'off'}
            </button>
          )}
        </div>
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
      {phase === 'playing' && bindings && <ControlsPanel bindings={bindings} />}
    </div>
  )
}

/** FR-06: current keys (remaps included) and where to change them. */
function ControlsPanel({ bindings }: { bindings: Binding[] }) {
  const rows = legend(bindings)
  return (
    <details className="rounded-xl border border-line bg-card p-4 text-sm" open>
      <summary className="cursor-pointer font-semibold">Controls</summary>
      <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.action} className="flex justify-between gap-4 border-b border-line py-1">
            <span className="text-muted">{r.action}</span>
            <span>
              <kbd className="font-mono">{r.key}</kbd>
              {r.pad && <span className="ml-2 text-muted">· {r.pad}</span>}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-muted">
        Gamepads work as soon as you press a button. Change keys or gamepad buttons under <b>Control Settings</b> (the
        gamepad icon in the emulator&apos;s bar); fullscreen and volume are there too. Save states stay in this tab only:
        they&apos;re gone when you reload, and cleared if your cloud save changes somewhere else.
      </p>
    </details>
  )
}

function SyncBadge({ status }: { status: SyncStatus }) {
  const [label, warn] = {
    synced: [status.state === 'synced' && status.flagged ? 'Saved — some Pokémon flagged for review' : 'Saved to cloud', status.state === 'synced' && status.flagged],
    syncing: ['Syncing…', false],
    offline: ["Offline — your save is kept on this device and will upload when you're back", true],
    conflict: ['Not syncing — your save changed somewhere else', true],
    locked: ['Locked while a trade finishes', true],
    rejected: [status.state === 'rejected' ? status.message : '', true],
  }[status.state] as [string, boolean]
  return <span className={warn ? 'text-warn' : 'text-muted'}>{label}</span>
}

/** A save from an earlier visit that can't be uploaded because the cloud moved on. Nothing is lost silently. */
function DeviceConflict({ save, gameCode, onContinue }: { save: PendingSave; gameCode: string; onContinue: () => void }) {
  const [href, setHref] = useState('')
  useEffect(() => {
    const url = URL.createObjectURL(new Blob([save.bytes]))
    setHref(url)
    return () => URL.revokeObjectURL(url)
  }, [save])
  const made = new Date(save.savedAt)

  return (
    <div className="mx-auto max-w-xl space-y-4 rounded-xl border border-warn bg-card p-6">
      <h2 className="text-lg font-semibold">This device has a save that never reached the cloud</h2>
      <p className="text-sm text-muted">
        It was made {made.toLocaleString()}, but your cloud save has changed since (another device, a restore or a
        trade), so it can't be uploaded. Keep a copy if you want it, then continue with the cloud save.
      </p>
      <div className="flex flex-wrap gap-3 text-sm">
        <a
          className="rounded-md border border-line px-3 py-1.5"
          href={href}
          download={`${gameCode}-unsynced-${made.toISOString().slice(0, 16).replace(':', '')}.sav`}
        >
          Download this device&apos;s save
        </a>
        <button className="rounded-md bg-accent px-3 py-1.5 font-medium text-white" onClick={onContinue}>
          Continue with the cloud save
        </button>
      </div>
    </div>
  )
}

function Banner({ children }: { children: React.ReactNode }) {
  return <div className="rounded-lg border border-warn bg-warn/10 px-4 py-3 text-sm">{children}</div>
}
