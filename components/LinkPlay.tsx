'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { io, type Socket } from 'socket.io-client'
import { EmulatorFrame, FrameClock, type CoreBuild } from '@/lib/client/emulator'
import { inspectRom, rememberRom, rememberedRom } from '@/lib/client/rom'
import { SaveSync, indexedDbQueue, romCheck, type SyncStatus } from '@/lib/client/save-sync'
import type { Binding } from '@/lib/client/controls'
import { DesyncCheck, HASH_EVERY, Lockstep } from '@/lib/client/lockstep'
import { ControlsPanel } from '@/components/Player'
import { loadEmulatorBindings, saveEmulatorBindings } from '@/lib/client/emulator-controls'
import type { Platform } from '@/lib/games'

interface Slot {
  id: string
  platform: Platform
  gameCode: string
  game: { name: string } | null
  trainerName: string | null
}
interface Seat {
  seat: number
  username: string
  mine: boolean
  slot: { id: string; gameCode: string; gameName: string; trainerName: string | null } | null
  romSha1: string | null
  ready: boolean
}
interface SessionView {
  id: string
  mode: 'SAME_DEVICE' | 'NETWORK'
  state: 'LOBBY' | 'ACTIVE' | 'ENDED'
  isHost: boolean
  rtcEpochMs: number | null
  inputDelay: number | null
  endReason: string | null
  seats: Seat[]
}
interface MySession { id: string; mode: 'SAME_DEVICE' | 'NETWORK'; state: string; host: string; players: number; invited: boolean }

const json = async <T,>(url: string, init?: RequestInit): Promise<T> => {
  const headers = new Headers(init?.headers)
  if (!(init?.body instanceof ArrayBuffer) && !headers.has('content-type')) headers.set('content-type', 'application/json')
  const res = await fetch(url, { ...init, headers })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new Error(body.message || `Request failed (${res.status})`)
  }
  return (res.status === 204 ? undefined : await res.json()) as T
}

/** mGBA link sessions: local in-memory cables plus lockstep network sessions. */
export function LinkPlay({ sessionId }: { sessionId?: string }) {
  const router = useRouter()
  const [slots, setSlots] = useState<Slot[]>([])
  const [view, setView] = useState<SessionView | null>(null)
  const [mySessions, setMySessions] = useState<MySession[]>([])
  const [createMode, setCreateMode] = useState<'SAME_DEVICE' | 'NETWORK'>('SAME_DEVICE')
  const [inviteName, setInviteName] = useState('')
  const [selected, setSelected] = useState<Record<number, string>>({})
  const [romReady, setRomReady] = useState<Record<number, boolean>>({})
  const [build, setBuild] = useState<CoreBuild | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [launchRequested, setLaunchRequested] = useState(false)
  const [bindings, setBindings] = useState<Binding[]>([])
  const [audioReady, setAudioReady] = useState(false)
  const [muted, setMuted] = useState(false)
  const [volume, setVolume] = useState(1)
  const persistedBindings = useRef<string | null>(null)
  const frame = useRef<HTMLIFrameElement>(null)
  const emu = useRef<EmulatorFrame | null>(null)
  const clock = useRef<FrameClock | null>(null)
  const roms = useRef(new Map<number, ArrayBuffer>())
  const syncs = useRef(new Map<number, SaveSync>())
  const pendingSaves = useRef(new Map<number, Promise<void>>())
  const launched = useRef(false)
  const socket = useRef<Socket | null>(null)
  const lockstep = useRef<Lockstep | null>(null)
  const desync = useRef(new DesyncCheck())

  const refresh = useCallback(async () => {
    const [slotResult, buildInfo] = await Promise.all([
      json<{ slots: Slot[] }>('/api/slots'),
      fetch('/emulator/core/build.json').then((r) => r.json() as Promise<CoreBuild>),
    ])
    setSlots(slotResult.slots)
    setBuild(buildInfo)
    if (sessionId) {
      const next = await json<SessionView>(`/api/link/${sessionId}`)
      setView(next)
      setSelected((old) => {
        const copy = { ...old }
        for (const seat of next.seats) if (seat.slot && !copy[seat.seat]) copy[seat.seat] = seat.slot.id
        return copy
      })
    } else {
      const sessions = await json<{ sessions: MySession[] }>('/api/link')
      setMySessions(sessions.sessions)
    }
  }, [sessionId])

  useEffect(() => {
    let active = true
    const load = async () => {
      try {
        await refresh()
        if (active) setError('')
      } catch (e) {
        if (active) setError((e as Error).message)
      } finally {
        if (active) setLoading(false)
      }
    }
    void load()
    if (!sessionId) return () => { active = false }
    const poll = window.setInterval(() => { void load() }, 2500)
    return () => { active = false; window.clearInterval(poll) }
  }, [refresh, sessionId])

  useEffect(() => () => {
    clock.current?.stop()
    emu.current?.dispose()
    for (const sync of syncs.current.values()) sync.dispose()
  }, [])

  async function create(slotId: string) {
    setBusy(true); setError('')
    try {
      const result = await json<{ id: string }>('/api/link', { method: 'POST', body: JSON.stringify({ mode: createMode, slotId }) })
      router.push(`/link/${result.id}`)
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function addGame(slotId: string) {
    if (!sessionId) return
    setBusy(true); setError('')
    try {
      await json(`/api/link/${sessionId}/seats`, { method: 'POST', body: JSON.stringify({ slotId }) })
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function inviteFriend() {
    if (!sessionId || !inviteName.trim()) return
    setBusy(true); setError('')
    try {
      await json(`/api/link/${sessionId}/invite`, { method: 'POST', body: JSON.stringify({ to: inviteName.trim() }) })
      setInviteName('')
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function chooseGame(seat: Seat, slotId: string) {
    setSelected((s) => ({ ...s, [seat.seat]: slotId }))
    setRomReady((r) => ({ ...r, [seat.seat]: false }))
    roms.current.delete(seat.seat)
    setError('')
    try {
      await json(`/api/link/${sessionId}/seats/${seat.seat}`, { method: 'PUT', body: JSON.stringify({ slotId }) })
      await refresh()
    } catch (e) { setError((e as Error).message) }
  }

  async function verifyGame(seat: Seat, file?: File) {
    const slot = slots.find((s) => s.id === selected[seat.seat])
    if (!slot || !build || !sessionId) return
    setBusy(true); setError('')
    try {
      let bytes = file ? (await inspectRom(file)).bytes : await rememberedRom(slot.gameCode)
      if (!bytes) throw new Error(`Choose your ${slot.game?.name ?? slot.gameCode} backup. The game stays on this device.`)
      const inspected = await inspectRom(new Blob([bytes]))
      if (inspected.platform !== slot.platform || inspected.code !== slot.gameCode) throw new Error('That game file does not match the selected slot.')
      const check = await json('/api/games/verify', { method: 'POST', body: JSON.stringify(romCheck(inspected)) })
      void check
      await rememberRom(slot.gameCode, bytes)
      await json(`/api/link/${sessionId}/seats/${seat.seat}`, {
        method: 'PUT', body: JSON.stringify({ slotId: slot.id, romSha1: inspected.sha1, coreBuild: build.sha256 }),
      })
      roms.current.set(seat.seat, bytes)
      setRomReady((r) => ({ ...r, [seat.seat]: true }))
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function start() {
    if (!sessionId) return
    setBusy(true); setError('')
    try {
      await json(`/api/link/${sessionId}/start`, { method: 'POST', body: JSON.stringify({ inputDelay: 1 }) })
      if (view?.mode === 'SAME_DEVICE') setLaunchRequested(true)
      await refresh()
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function bootLinkedGames() {
    if (!view || !sessionId || !frame.current || !build) return
    const localSeats = view.mode === 'SAME_DEVICE' ? view.seats.map((s) => s.seat) : view.seats.filter((s) => s.mine).map((s) => s.seat)
    const games = [] as { rom: ArrayBuffer; save: ArrayBuffer | null }[]
    for (const seat of [...view.seats].sort((a, b) => a.seat - b.seat)) {
      const slot = slots.find((s) => s.id === (selected[seat.seat] ?? seat.slot?.id))
      const gameCode = slot?.gameCode ?? seat.slot?.gameCode
      const platform = slot?.platform ?? 'GBA'
      if (!gameCode) throw new Error(`Choose a game for player ${seat.seat + 1}.`)
      let bytes = roms.current.get(seat.seat) ?? await rememberedRom(gameCode)
      if (!bytes) throw new Error(`Load the ${slot?.game?.name ?? seat.slot?.gameName ?? gameCode} backup for player ${seat.seat + 1}.`)
      const inspected = await inspectRom(new Blob([bytes]))
      if (inspected.platform !== platform || inspected.code !== gameCode || (seat.romSha1 && inspected.sha1 !== seat.romSha1))
        throw new Error(`Player ${seat.seat + 1}'s local game does not match the session.`)
      roms.current.set(seat.seat, bytes)
      const saveRes = await fetch(`/api/link/${sessionId}/saves/${seat.seat}`, { cache: 'no-store' })
      if (!saveRes.ok) throw new Error(`Could not load player ${seat.seat + 1}'s starting save.`)
      const save = saveRes.status === 204 ? null : await saveRes.arrayBuffer()
      games[seat.seat] = { rom: bytes, save }
      if (localSeats.includes(seat.seat)) {
        if (!slot) throw new Error(`Your slot for player ${seat.seat + 1} is not available.`)
        const sync = new SaveSync({
          slotId: slot.id, platform: slot.platform, queue: indexedDbQueue,
          onStatus: (s: SyncStatus) => {
            if (s.state === 'conflict' || s.state === 'locked') {
              clock.current?.stop()
              emu.current?.send({ type: 'pause' })
              setError(`Player ${seat.seat + 1}'s save needs attention: ${s.state}. The link session was stopped to protect it.`)
              void json(`/api/link/${sessionId}`, { method: 'DELETE' }).catch(() => undefined)
            }
          },
        })
        const boot = await sync.boot(saveRes.headers.get('x-version-id') ?? 'none', save)
        if ('conflict' in boot) throw new Error(`Player ${seat.seat + 1} has an unsynced local save. Resolve it in the normal play page before linking.`)
        games[seat.seat] = { rom: bytes, save: boot.save }
        syncs.current.set(seat.seat, sync)
      }
    }
    if (view.mode === 'NETWORK' && localSeats.length === 0) throw new Error('This account has no game in the session.')
    const e = new EmulatorFrame(frame.current)
    emu.current = e
    let c: FrameClock
    if (view.mode === 'NETWORK') {
      const schedule = new Lockstep(games.length, localSeats, Math.max(2, view.inputDelay ?? 3))
      lockstep.current = schedule
      const peer = io({ path: '/socket.io' })
      socket.current = peer
      peer.on('link:msg', (msg: { t?: string; p?: number; f?: number; k?: number; h?: number }) => {
        if (msg.t === 'i' && Number.isInteger(msg.p) && Number.isInteger(msg.f) && Number.isInteger(msg.k))
          schedule.addRemote({ p: msg.p!, f: msg.f!, k: msg.k! })
        if (msg.t === 'h' && Number.isInteger(msg.p) && Number.isInteger(msg.f) && Number.isInteger(msg.h)) {
          const mismatch = desync.current.remote(msg.p!, msg.f!, msg.h!)
          if (mismatch !== null) {
            setError(`The linked games fell out of sync at frame ${mismatch}. The cable was cut.`)
            clock.current?.stop()
            void json(`/api/link/${sessionId}?reason=desync`, { method: 'DELETE' }).catch(() => undefined)
          }
        }
      })
      peer.on('link:go', () => c.start())
      peer.on('link:peer-left', () => { c.stop(); setError('A player disconnected, so the link cable was cut.') })
      const joined = await new Promise<boolean>((resolve) => {
        peer.emit('link:join', sessionId, (result: { ok: boolean }) => resolve(!!result?.ok))
      })
      if (!joined) { peer.disconnect(); throw new Error('Could not join the link relay. Reload the session and try again.') }
      c = new FrameClock(async () => {
        const inputs = schedule.take()
        if (!inputs) return false
        const targetFrame = schedule.frame - 1
        const result = await e.runFrames(1, inputs, targetFrame % HASH_EVERY === 0)
        result.local.forEach((keys, index) => {
          const msg = schedule.addLocal(localSeats[index], keys)
          peer.emit('link:msg', sessionId, { t: 'i', ...msg })
        })
        if (result.hash !== undefined && targetFrame % HASH_EVERY === 0) {
          const mismatch = desync.current.local(targetFrame, result.hash)
          peer.emit('link:msg', sessionId, { t: 'h', p: localSeats[0], f: targetFrame, h: result.hash })
          if (mismatch !== null) {
            setError(`The linked games fell out of sync at frame ${mismatch}. The cable was cut.`)
            peer.disconnect()
            void json(`/api/link/${sessionId}?reason=desync`, { method: 'DELETE' }).catch(() => undefined)
          }
        }
        return true
      })
    } else {
      c = new FrameClock(async () => { await e.runFrames(1); return true })
    }
    clock.current = c
    e.on('ready', () => {
      void loadEmulatorBindings().catch(() => ({})).then((saved) => {
        e.boot({ games, local: localSeats, bindings: saved, rtc: { mode: 'fixed', epochMs: view.rtcEpochMs ?? Date.now() } })
      })
    })
    e.on('started', () => {
      setPlaying(true)
      if (view.mode === 'SAME_DEVICE') c.start()
      else socket.current?.emit('link:booted', sessionId)
    })
    e.on('error', (m) => { c.stop(); setError(String(m.message)); setPlaying(false) })
    e.on('save', (m) => {
      const core = m.core as number
      const job = syncs.current.get(core)?.submit(m.bytes as ArrayBuffer)
      if (job) {
        pendingSaves.current.set(core, job)
        void job.finally(() => { if (pendingSaves.current.get(core) === job) pendingSaves.current.delete(core) })
      }
    })
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
  }

  async function loadSessionRom(seat: Seat, file: File) {
    setBusy(true); setError('')
    try {
      const inspected = await inspectRom(file)
      if (inspected.platform !== 'GBA' || inspected.code !== seat.slot?.gameCode) throw new Error(`Choose the ${seat.slot?.gameName ?? 'matching'} GBA game file.`)
      if (seat.romSha1 && inspected.sha1 !== seat.romSha1) throw new Error('This file does not match the ROM hash registered for the session.')
      await json('/api/games/verify', { method: 'POST', body: JSON.stringify(romCheck(inspected)) })
      await rememberRom(inspected.code, inspected.bytes)
      roms.current.set(seat.seat, inspected.bytes)
      setRomReady((r) => ({ ...r, [seat.seat]: true }))
    } catch (e) { setError((e as Error).message) } finally { setBusy(false) }
  }

  async function end() {
    if (!sessionId) return
    clock.current?.stop()
    if (emu.current) {
      const flush = new Promise<void>((resolve) => {
        let off: () => void = () => {}
        const timer = window.setTimeout(() => { off(); resolve() }, 5000)
        off = emu.current?.on('flushed', () => { window.clearTimeout(timer); off(); resolve() }) ?? off
      })
      emu.current.send({ type: 'flush' })
      await flush
    }
    await Promise.all(pendingSaves.current.values())
    socket.current?.disconnect()
    socket.current = null
    for (const sync of syncs.current.values()) { await sync.idle(); sync.dispose() }
    try { await json(`/api/link/${sessionId}`, { method: 'DELETE' }) } catch { /* session may already have ended */ }
    setPlaying(false)
    await refresh()
  }

  if (loading) return <p className="text-sm text-muted">Loading link play…</p>
  if (!sessionId) return (
    <div className="max-w-xl space-y-4 rounded-xl border border-line bg-card p-6">
      <h1 className="text-2xl font-semibold">Link play</h1>
      <p className="text-sm text-muted">Connect GBA games through mGBA. Same-device play links your slots in memory; network sessions link friends through the site relay.</p>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-4 text-sm">
        <label className="flex items-center gap-2"><input type="radio" checked={createMode === 'SAME_DEVICE'} onChange={() => setCreateMode('SAME_DEVICE')} /> Same device</label>
        <label className="flex items-center gap-2"><input type="radio" checked={createMode === 'NETWORK'} onChange={() => setCreateMode('NETWORK')} /> Invite a friend</label>
      </div>
      {slots.filter((s) => s.platform === 'GBA').length < (createMode === 'SAME_DEVICE' ? 2 : 1) ? <p className="text-sm text-muted">{createMode === 'SAME_DEVICE' ? 'You need at least two GBA game slots to start a local link session.' : 'You need a GBA game slot to start a network link session.'}</p> : slots.filter((s) => s.platform === 'GBA').map((s) => (
        <button key={s.id} disabled={busy} onClick={() => void create(s.id)} className="mr-2 rounded-md bg-accent px-3 py-2 text-sm font-medium text-white disabled:opacity-50">
          {createMode === 'NETWORK' ? 'Invite from ' : 'Start with '}{s.game?.name ?? s.gameCode}
        </button>
      ))}
      {mySessions.length > 0 && <div className="space-y-2 border-t border-line pt-3">
        <h2 className="text-sm font-semibold">Your open sessions</h2>
        {mySessions.map((s) => <button key={s.id} onClick={() => router.push(`/link/${s.id}`)} className="block text-left text-sm underline">{s.mode === 'NETWORK' ? 'Network' : 'Same device'} · {s.players} game{s.players === 1 ? '' : 's'} · {s.state.toLowerCase()}{s.invited ? ' · invitation' : ''}</button>)}
      </div>}
    </div>
  )

  if (!view) return <div className="text-sm text-danger">{error || 'Link session not found.'}</div>
  const assigned = new Set(view.seats.map((s) => selected[s.seat] ?? s.slot?.id).filter(Boolean))
  const addable = slots.find((s) => s.platform === 'GBA' && !assigned.has(s.id))
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">{view.mode === 'NETWORK' ? 'Network link session' : 'Local link session'}</h1>
        <p className="mt-1 text-sm text-muted">{view.state === 'ACTIVE' ? 'Cable connected. Player 1 uses the keyboard; other players use gamepads.' : 'Choose each game and load its local game file before starting.'}</p>
      </div>
      {error && <p className="rounded-md border border-warn p-3 text-sm text-danger">{error}</p>}
      {!playing && view.state === 'LOBBY' && <div className="space-y-3 rounded-xl border border-line bg-card p-4">
        {view.seats.map((seat) => {
          const own = slots.filter((s) => s.platform === 'GBA' && (!assigned.has(s.id) || selected[seat.seat] === s.id))
          const currentSlot = slots.find((s) => s.id === selected[seat.seat])
          return <div key={seat.seat} className="flex flex-wrap items-center gap-3 border-b border-line py-2 last:border-0">
            <span className="w-28 text-sm font-medium">Player {seat.seat + 1}{view.mode === 'NETWORK' ? ` · ${seat.username}` : ''}</span>
            {seat.mine && <select className="rounded border border-line bg-background px-2 py-1 text-sm" value={selected[seat.seat] ?? ''} onChange={(e) => void chooseGame(seat, e.target.value)}>
              <option value="">Choose a game…</option>{own.map((s) => <option key={s.id} value={s.id}>{s.game?.name ?? s.gameCode}</option>)}
            </select>}
            {!seat.mine && <span className="text-sm text-muted">{seat.slot?.gameName ?? 'Waiting for an invitee to choose a game'}</span>}
            {seat.mine && currentSlot && <>
              <input aria-label={`Player ${seat.seat + 1} game file`} type="file" accept=".gba" onChange={(e) => e.target.files?.[0] && void verifyGame(seat, e.target.files[0])} className="max-w-56 text-xs" />
              <button disabled={busy || !build} onClick={() => void verifyGame(seat)} className="rounded border border-line px-2 py-1 text-xs">Use saved game file</button>
              <span className={romReady[seat.seat] || seat.ready ? 'text-xs text-green-600' : 'text-xs text-muted'}>{romReady[seat.seat] || seat.ready ? 'Ready' : 'Load file to verify'}</span>
            </>}
          </div>
        })}
        {view.mode === 'SAME_DEVICE' && view.seats.length < 4 && addable && <button disabled={busy} onClick={() => void addGame(addable.id)} className="text-sm underline">Add another game</button>}
        {view.mode === 'NETWORK' && view.isHost && view.seats.length < 4 && <div className="flex gap-2"><input value={inviteName} onChange={(e) => setInviteName(e.target.value)} placeholder="Friend username or code" className="rounded border border-line bg-background px-2 py-1 text-sm" /><button disabled={busy || !inviteName.trim()} onClick={() => void inviteFriend()} className="rounded border border-line px-3 py-1 text-sm">Invite</button></div>}
        {view.mode === 'NETWORK' && <p className="text-xs text-muted">Each player loads their own game here. For synchronized play, every browser also needs local copies of each session game.</p>}
        {view.isHost && <button disabled={busy || view.seats.length < 2 || view.seats.some((s) => !s.slot || !s.ready)} onClick={() => void start()} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">{busy ? 'Starting…' : 'Connect cable'}</button>}
      </div>}
      {view.state === 'ACTIVE' && <div className="space-y-3">
        {view.mode === 'NETWORK' && !playing && <div className="space-y-2 rounded-xl border border-line bg-card p-4">
          <p className="text-sm">Every browser runs every game to keep the link deterministic. Choose local copies matching each player&apos;s checked game file.</p>
          {view.seats.map((seat) => <label key={seat.seat} className="flex flex-wrap items-center gap-3 text-sm">
            <span className="w-40">Player {seat.seat + 1} · {seat.username} · {seat.slot?.gameName ?? 'game pending'}</span>
            <input type="file" accept=".gba" disabled={!seat.slot || busy} onChange={(e) => e.target.files?.[0] && void loadSessionRom(seat, e.target.files[0])} className="max-w-56 text-xs" />
            <span className={romReady[seat.seat] || roms.current.has(seat.seat) ? 'text-xs text-green-600' : 'text-xs text-muted'}>{romReady[seat.seat] || roms.current.has(seat.seat) ? 'Ready on this device' : 'Needed on this device'}</span>
          </label>)}
          <button disabled={busy || view.seats.some((s) => !roms.current.has(s.seat))} onClick={() => { launched.current = false; setLaunchRequested(true) }} className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-white disabled:opacity-50">Run linked games</button>
        </div>}
        {launchRequested && <iframe ref={frame} src="/emulator/index.html" title="Linked Pokémon games" allow="fullscreen; gamepad; autoplay" onLoad={() => {
          if (!launched.current) {
            launched.current = true
            void bootLinkedGames().catch((e) => { launched.current = false; setError((e as Error).message) })
          }
        }} className="aspect-[3/2] w-full rounded-xl border border-line bg-black" />}
        {playing && bindings.length > 0 && <ControlsPanel bindings={bindings} onBind={(action, code) => emu.current?.send({ type: 'bind', action, code })} onReset={() => emu.current?.send({ type: 'reset-bindings' })} linked
          audioReady={audioReady} muted={muted} volume={volume}
          onEnableAudio={() => {
            const child = frame.current?.contentWindow as (Window & { enableHubAudio?: () => void }) | null
            if (child?.enableHubAudio) child.enableHubAudio()
            else emu.current?.send({ type: 'enable-audio' })
          }}
          onMute={() => { const next = !muted; setMuted(next); emu.current?.send({ type: 'audio-settings', muted: next, volume }) }}
          onVolume={(value) => { setVolume(value); emu.current?.send({ type: 'audio-settings', muted, volume: value }) }}
          onFullscreen={() => void frame.current?.requestFullscreen()} />}
        <button onClick={() => void end()} className="rounded-md border border-line px-3 py-1.5 text-sm">End link session</button>
      </div>}
      {view.state === 'ENDED' && <div className="rounded-xl border border-line bg-card p-4 text-sm">Session ended{view.endReason ? ` (${view.endReason})` : ''}. Save uploads are still syncing. <button className="ml-2 underline" onClick={() => router.push('/link')}>Start another</button></div>}
    </div>
  )
}
