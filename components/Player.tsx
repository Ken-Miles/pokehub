'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io } from 'socket.io-client'
import { FileDrop } from '@/components/FileDrop'
import { LinkCable } from '@/components/LinkCable'
import { Wireless } from '@/components/Wireless'
import { forgetRom, inspectRom, rememberRom, rememberedRom } from '@/lib/client/rom'
import { canBind, legend, type Action, type Binding } from '@/lib/client/controls'
import { EmulatorFrame, FrameClock } from '@/lib/client/emulator'
import { loadEmulatorBindings, saveEmulatorBindings } from '@/lib/client/emulator-controls'
import { SaveSync, indexedDbQueue, romCheck, type PendingSave, type SyncStatus } from '@/lib/client/save-sync'
import { PLATFORMS, type Platform } from '@/lib/games'
import { airable } from '@/lib/link-rules'

/** Frames per tick while fast-forwarding (FR-06): 3× speed. */
const FAST_FORWARD = 3

type Phase = 'need-rom' | 'loading' | 'device-conflict' | 'playing' | 'stale' | 'locked' | 'error'
interface Props {
  slotId: string
  platform: Platform
  gameCode: string
  gameName: string
}

/**
 * Hosts the emulator iframe (ADR-011) and keeps the slot's cloud save in sync
 * (FR-08) through SaveSync: unsent saves wait in IndexedDB and are retried;
 * every upload names the version it was built on, and a 409 means this tab is
 * stale (another tab, a trade or a restore), so the emulator stops (ADR-006).
 */
export function Player({ slotId, platform, gameCode, gameName }: Props) {
  const frame = useRef<HTMLIFrameElement>(null)
  const emu = useRef<EmulatorFrame | null>(null)
  const clock = useRef<FrameClock | null>(null)
  const rom = useRef<ArrayBuffer | null>(null)
  const bootSave = useRef<ArrayBuffer | null>(null)
  const sync = useRef<SaveSync | null>(null)
  const [phase, setPhase] = useState<Phase>('need-rom')
  const [status, setStatus] = useState<SyncStatus>({ state: 'synced', flagged: false })
  const [deviceSave, setDeviceSave] = useState<PendingSave | null>(null)
  const [error, setError] = useState('')
  const [remember, setRemember] = useState(true)
  const [bindings, setBindings] = useState<Binding[] | null>(null)
  const [audioReady, setAudioReady] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const [fastForward, setFastForward] = useState(false)
  const [cable, setCable] = useState(false)
  const [air, setAir] = useState(false)
  const [waiting, setWaiting] = useState(false)
  const waitingRef = useRef(false)
  const fastRef = useRef(false)
  const persistedBindings = useRef<string | null>(null)
  const statusRef = useRef<SyncStatus['state']>('synced')

  const send = (msg: object) => emu.current?.send(msg)

  // The cloud save moved on without this tab: pause, and drop save states made
  // before that change so none can be loaded and saved over it (ADR-016).
  const stop = useCallback((next: 'stale' | 'locked') => {
    clock.current?.stop()
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
        statusRef.current = st.state
        if (st.state === 'conflict' || st.state === 'locked') {
          clock.current?.stop()
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

  // A save still on its way to the cloud: ask before the tab closes. A link trade
  // only counts if its save arrives within LINK_GRACE_MS of the link ending.
  useEffect(() => {
    if (status.state !== 'syncing' && status.state !== 'offline') return
    const warn = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', warn)
    return () => window.removeEventListener('beforeunload', warn)
  }, [status.state])

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

  // The emulator iframe: boot it with the game and the cloud save, then run frames at the GBA's rate.
  useEffect(() => {
    if (phase !== 'playing' || !frame.current) return
    const e = new EmulatorFrame(frame.current)
    emu.current = e
    const c = new FrameClock(async () => {
      // Fast-forward runs several frames per tick; the iframe plays only the last one's sound.
      const r = await e.runFrames(fastRef.current ? FAST_FORWARD : 1)
      // Gen 3 cable: the game held a frame back for the friend's words (ADR-021).
      if (!!r.waiting !== waitingRef.current) setWaiting((waitingRef.current = !!r.waiting))
      return true
    })
    clock.current = c
    e.on('ready', () => {
      void loadEmulatorBindings().catch(() => ({})).then((saved) => {
        if (rom.current) e.boot({ platform: platform === 'GB' ? 'GB' : 'GBA', games: [{ rom: rom.current, save: bootSave.current }], local: [0], bindings: saved, rtc: { mode: 'wall' } })
      })
    })
    e.on('started', () => c.start())
    e.on('error', (m) => {
      c.stop()
      setError(String(m.message))
      setPhase('error')
    })
    e.on('save', (m) => void sync.current?.submit(m.bytes as ArrayBuffer))
    e.on('unchanged', () => void sync.current?.retryNow())
    e.on('controls', (m) => {
      const nextBindings = m.keys as Binding[]
      setBindings(nextBindings)
      const signature = JSON.stringify(nextBindings.map(({ id, key }) => [id, key]))
      if (persistedBindings.current !== signature) {
        persistedBindings.current = signature
        void saveEmulatorBindings(nextBindings).catch(() => {
          persistedBindings.current = null
          setError('Could not save your emulator controls to your account.')
        })
      }
      setMuted(!!m.muted)
      setVolume(typeof m.volume === 'number' ? m.volume : 1)
    })
    e.on('audio', (m) => setAudioReady(m.state === 'running'))
    // Hidden tab: stop running (and stop sound) until it's back.
    const onVisible = () => {
      if (document.hidden) {
        c.stop()
        e.send({ type: 'pause' })
      } else if (sync.current && !['conflict', 'locked'].includes(statusRef.current)) {
        e.send({ type: 'resume' })
        c.start()
      }
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      c.stop()
      e.dispose()
      emu.current = null
      clock.current = null
    }
  }, [phase])

  // Another tab, a restore or (later) a trade moved this slot on: stop before we overwrite it.
  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    // Tell friends I'm playing this slot, for the link cable (FR-34); again after a reconnect.
    socket.on('connect', () => socket.emit('play:here', slotId))
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
        <FileDrop label={`Your ${gameName} backup (${PLATFORMS[platform].romExtension})`} accept={PLATFORMS[platform].romExtension ?? ""} onFile={pick} />
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
          {waiting && <span className="text-warn">Waiting for your friend&rsquo;s game…</span>}
          {phase === 'playing' && status.state !== 'syncing' && (
            <button className="underline" onClick={syncNow}>
              Sync now
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
          className="aspect-[3/2] w-full rounded-xl border border-line bg-black pointer-coarse:portrait:aspect-[3/4]"
        />
      )}
      {phase === 'playing' && bindings && (
        <ControlsPanel
          bindings={bindings}
          onBind={(action, code) => {
            send({ type: 'bind', action, code })
            frame.current?.focus()
          }}
          onReset={() => send({ type: 'reset-bindings' })}
          audioReady={audioReady}
          muted={muted}
          volume={volume}
          onEnableAudio={() => {
            const child = frame.current?.contentWindow as (Window & { enableHubAudio?: () => void }) | null
            if (child?.enableHubAudio) child.enableHubAudio()
            else send({ type: 'enable-audio' })
          }}
          onMute={() => { const next = !muted; setMuted(next); send({ type: 'audio-settings', muted: next, volume }) }}
          onVolume={(value) => { setVolume(value); send({ type: 'audio-settings', muted, volume: value }) }}
          onFullscreen={() => void frame.current?.requestFullscreen()}
          fastForward={fastForward}
          linked={cable || air}
          onFastForward={() => {
            fastRef.current = !fastRef.current
            setFastForward(fastRef.current)
            frame.current?.focus()
          }}
        />
      )}
      {phase === 'playing' && (platform === 'GB' || platform === 'GBA') && (
        <LinkCable
          slotId={slotId}
          emu={() => emu.current}
          disabled={air}
          onPlugged={(on) => {
            // One speed while plugged in: the friend's game can't keep up with fast-forward.
            fastRef.current = false
            setFastForward(false)
            setCable(on)
          }}
        />
      )}
      {phase === 'playing' && airable(platform, gameCode) && (
        <Wireless
          slotId={slotId}
          emu={() => emu.current}
          disabled={cable}
          onOn={(on) => {
            fastRef.current = false
            setFastForward(false)
            setAir(on)
          }}
        />
      )}
    </div>
  )
}

/** FR-06: current keys (remaps included); click a key to change it. */
export function ControlsPanel({
  bindings,
  onBind,
  onReset,
  linked = false,
  audioReady = true,
  muted = false,
  volume = 1,
  onEnableAudio,
  onMute,
  onVolume,
  onFullscreen,
  fastForward = false,
  onFastForward,
}: {
  bindings: Binding[]
  onBind: (action: Action, code: string) => void
  onReset: () => void
  linked?: boolean
  audioReady?: boolean
  muted?: boolean
  volume?: number
  onEnableAudio?: () => void
  onMute?: () => void
  onVolume?: (value: number) => void
  onFullscreen?: () => void
  /** Solo only: lockstep has one speed. */
  fastForward?: boolean
  onFastForward?: () => void
}) {
  const [listening, setListening] = useState<Action | null>(null)
  const rows = legend(bindings, { linked })

  useEffect(() => {
    if (!listening) return
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault()
      if (e.code !== 'Escape' && canBind(e.code)) onBind(listening, e.code)
      setListening(null)
    }
    window.addEventListener('keydown', onKey, { once: true })
    return () => window.removeEventListener('keydown', onKey)
  }, [listening, onBind])

  return (
    <details className="rounded-xl border border-line bg-card p-4 text-sm" open>
      <summary className="cursor-pointer font-semibold">Controls</summary>
      <div className="mt-3 flex flex-wrap items-center gap-3 border-b border-line pb-3">
        <span className="font-medium">Settings</span>
        {!audioReady && <button className="rounded border border-line px-2 py-1" onClick={onEnableAudio}>Enable sound</button>}
        <button className="rounded border border-line px-2 py-1" aria-pressed={muted} onClick={onMute}>{muted ? 'Unmute' : 'Mute'}</button>
        {onFastForward && !linked && (
          <button className="rounded border border-line px-2 py-1" aria-pressed={fastForward} onClick={onFastForward}>
            {fastForward ? 'Normal speed' : 'Fast-forward'}
          </button>
        )}
        <label className="flex items-center gap-2 text-muted">Volume
          <input aria-label="Volume" type="range" min="0" max="1" step="0.05" value={volume} onChange={(e) => onVolume?.(Number(e.target.value))} />
        </label>
        <button className="rounded border border-line px-2 py-1" onClick={onFullscreen}>Fullscreen</button>
      </div>
      <div className="mt-3 grid gap-x-8 gap-y-1 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.id} className="flex items-center justify-between gap-4 border-b border-line py-1">
            <span className="text-muted">{r.action}</span>
            <button
              className="rounded border border-line px-1.5 font-mono"
              aria-label={`Change the key for ${r.action}`}
              onClick={() => setListening(r.id)}
            >
              {listening === r.id ? 'Press a key…' : r.key}
            </button>
          </div>
        ))}
      </div>
      <p className="mt-3 text-muted">
        Click a key to change it (Esc cancels); your key bindings are saved to your account.{' '}
        <button className="underline" onClick={onReset}>
          Reset to defaults
        </button>
        . Gamepads work as soon as you press a button.{' '}
        {linked
          ? 'While linked, player 1 uses the keyboard and the others use gamepads in order; save states are off.'
          : "Save states stay in this tab only: they're gone when you reload, and cleared if your cloud save changes somewhere else."}
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
