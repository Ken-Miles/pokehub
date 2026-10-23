import { createHash } from 'crypto'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import type { Socket } from 'socket.io-client'
import { framesDue, GBA_FPS } from '@/lib/client/emulator'
import { Gba, KEY, type Button } from './core'
import { Site } from './site'

/**
 * One bot (FR-36, ADR-023): a bot account playing its slot's game on our core, at
 * the GBA's own speed, through the same API and relay as the play page
 * (components/Player.tsx, components/LinkCable.tsx). Game files come only from the
 * bot host's read-only folder; only header code + SHA-1 go to the site.
 */

interface Slot { id: string; slotNumber: number; platform: string; gameCode: string; origin: string; currentVersionId: string | null }
interface LinkView { state: string; isHost?: boolean; seats: { seat: number; username: string; mine: boolean; ready?: boolean; left?: boolean; slot: { id: string } | null }[] }
interface Friend { userId: string; username: string; busy: boolean }

export interface GameFile { code: string; sha1: string; path: string }

/** Every .gba in the folder by header code (0xAC). Read once per lookup; the folder is read-only. */
export function findGame(dir: string, code: string): GameFile {
  for (const name of readdirSync(dir)) {
    if (!name.toLowerCase().endsWith('.gba')) continue
    const path = join(dir, name)
    const bytes = readFileSync(path)
    if (bytes.subarray(0xac, 0xb0).toString('latin1') !== code) continue
    return { code, sha1: createHash('sha1').update(bytes).digest('hex'), path }
  }
  throw new Error(`No ${code} game in ${dir}.`)
}

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

export class Bot {
  gba: Gba | null = null
  slot: Slot | null = null
  game: GameFile | null = null
  /** The plugged-in cable: session, my seat, the relay socket. */
  cable: { sessionId: string; seat: number; with: string; peer: Socket } | null = null
  /** The wireless adapter, on in a room (FR-35): session, my seat, the relay socket. */
  air: { sessionId: string; seat: number; host: boolean; peer: Socket } | null = null
  /** Accept every cable request from a friend (FR-36: bots answer testers and other bots). */
  autoAccept = true
  /** The admin controlling this bot from /admin/bots: their buttons replace the bot's, and commands wait (lib/bot-watch.ts). */
  controlledBy: string | null = null
  frames = 0
  private socket: Socket | null = null
  private timer: NodeJS.Timeout | null = null
  /** Sends the screen to /admin/bots while an admin is watching (lib/bot-watch.ts). */
  private screenTimer: NodeJS.Timeout | null = null
  private keys = 0
  private adminKeys = 0
  /** Buttons pressed since the last frame: a quick tap can come and go between two frames. */
  private tapped = 0
  private waiters: (() => void)[] = []
  private versionId: string | null = null
  private savedHash = ''
  private pluggedWaiters: (() => void)[] = []

  constructor(
    readonly name: string,
    readonly site: Site,
    private readonly gamesDir: string,
  ) {}

  log(msg: string) {
    console.log(`[${this.name}] ${msg}`)
  }

  get running() {
    return !!this.timer
  }

  /** What the bot is doing, for `list` and /admin/bots. */
  get status() {
    const state = !this.running ? 'off' : this.cable ? `cable to ${this.cable.with}` : this.air ? `wireless seat ${this.air.seat}${this.air.host ? ' (host)' : ''}` : 'on'
    return `${state}${this.game ? `  ${this.game.code}` : ''}${this.running ? `  frame ${this.frames}` : ''}${this.controlledBy ? `  ${this.controlledBy} has control` : ''}`
  }

  /** Boot the bot's slot (the first, or `slotNumber`) from its cloud save and go online. */
  async start(slotNumber?: number) {
    if (this.running) return
    const { slots } = await this.site.json<{ slots: Slot[] }>('/api/slots')
    const slot = slots.find((s) => s.platform === 'GBA' && (slotNumber === undefined || s.slotNumber === slotNumber))
    if (!slot) throw new Error('This bot has no GBA slot. Use setup first.')
    const game = findGame(this.gamesDir, slot.gameCode)
    await this.site.json('/api/games/verify', { method: 'POST', body: JSON.stringify({ platform: 'GBA', code: game.code, sha1: game.sha1 }) })
    const res = await this.site.raw(`/api/slots/${slot.id}/saves/current`)
    const save = res.status === 204 ? null : new Uint8Array(await res.arrayBuffer())
    this.versionId = res.headers.get('x-version-id') === 'none' ? null : res.headers.get('x-version-id')
    this.savedHash = save ? sha256(save) : ''
    this.gba = await Gba.boot(readFileSync(game.path), save)
    this.slot = slot
    this.game = game

    const socket = this.site.socket()
    this.socket = socket
    socket.on('connect', () => socket.emit('play:here', slot.id))
    socket.on('connect_error', (e) => this.log(`site connection: ${e.message}`))
    socket.on('bots:watch', (on: boolean) => this.watched(on))
    socket.on('bot:control', (r: { by: string | null }) => {
      if (r.by === this.controlledBy) return
      this.controlledBy = r.by
      this.adminKeys = this.tapped = 0
      this.log(r.by ? `${r.by} took control; commands wait` : 'control returned; commands carry on')
    })
    socket.on('bot:keys', (keys: number) => {
      if (!this.controlledBy) return
      this.adminKeys = keys
      this.tapped |= keys
    })
    socket.on('cable:request', (r: { sessionId: string; from: string; slotId: string }) => {
      if (r.slotId !== slot.id) return
      this.log(`${r.from} wants to link cables${this.autoAccept ? ' — accepting' : ''}`)
      if (this.autoAccept) this.site.json(`/api/cable/${r.sessionId}/accept`, { method: 'POST' }).catch((e) => this.log(e.message))
    })
    socket.on('cable:plugged', (r: { sessionId: string }) => void this.plugIn(r.sessionId).catch((e) => this.log(`plug in failed: ${e.message}`)))
    socket.on('air:invite', (r: { sessionId: string; from: string; slotId: string }) => {
      if (r.slotId !== slot.id) return
      this.log(`${r.from} invited us to a wireless room${this.autoAccept ? ' — joining' : ''}`)
      if (this.autoAccept) void this.joinRoom(r.sessionId).catch((e) => this.log(`joining the room failed: ${e.message}`))
    })
    socket.on('link:updated', (r: { sessionId: string }) => {
      if (r.sessionId !== this.air?.sessionId) return
      // As Wireless.tsx refresh: the host closed the room, or we're no longer in it.
      void this.site.json<LinkView>(`/api/link/${r.sessionId}`).then((view) => {
        if (view.state === 'ENDED' || !view.seats.some((s) => s.mine && !s.left)) {
          this.log('the wireless room was closed')
          this.airOff()
        }
      }).catch(() => {})
    })

    let last = performance.now()
    let debt = 0
    // shortcut: every bot runs on the host's main thread; move each to a worker thread when one host runs many bots.
    this.timer = setInterval(() => {
      const now = performance.now()
      const due = framesDue(now - last, debt)
      last = now
      debt = due.debtMs
      for (let i = 0; i < due.frames; i++) this.step()
    }, 4)
    this.log(`playing ${game.code} slot ${slot.slotNumber}`)
  }

  private step() {
    const gba = this.gba!
    if (!gba.frame(this.controlledBy ? this.adminKeys | this.tapped : this.keys)) return // held back for the cable child: the frame didn't run
    this.tapped = 0
    this.frames++
    if (this.cable) for (const m of gba.takeCable()) this.cable.peer.emit('link:msg', this.cable.sessionId, { t: 'c', p: this.cable.seat, ...m })
    if (this.air) {
      for (const m of gba.takeAir()) this.air.peer.emit('link:msg', this.air.sessionId, { t: 'a', p: this.air.seat, ...m })
      const trace = gba.airTrace()
      if (trace) this.log(`wireless adapter, recent events (state 0 idle, 1–2 hosting, 3 searching, 4 connecting, 5 connected):\n${trace}`)
    }
    if (this.controlledBy) return // commands count frames; none pass while an admin plays
    const ready = this.waiters
    this.waiters = []
    for (const w of ready) w()
  }

  async stop() {
    if (!this.running) return
    await this.unplug().catch(() => {})
    await this.leaveRoom().catch(() => {})
    await this.uploadSave().catch((e) => this.log(`last save not uploaded: ${e.message}`))
    clearInterval(this.timer!)
    this.timer = null
    this.watched(false)
    this.controlledBy = null
    this.socket?.disconnect()
    this.socket = null
    this.gba = null
    this.log('stopped')
  }

  private watched(on: boolean) {
    if (this.screenTimer) clearInterval(this.screenTimer)
    this.screenTimer = null
    // shortcut: 10 PNGs a second (ADR-023) on the bot host's main thread; fine for a handful of bots.
    if (on) this.screenTimer = setInterval(() => {
      if (this.gba) this.socket?.volatile.emit('bot:screen', { png: this.gba.screenshot(), status: this.status })
    }, 100)
  }

  // ---------------------------------------------------------------- inputs

  /** Resolves after `n` more frames have run. */
  wait(n = 1): Promise<void> {
    return new Promise((resolve) => {
      let left = n
      const tick = () => (--left <= 0 ? resolve() : this.waiters.push(tick))
      if (!this.running) throw new Error(`${this.name} is not running.`)
      this.waiters.push(tick)
    })
  }

  async hold(buttons: Button[], frames: number) {
    this.keys = buttons.reduce((k, b) => k | KEY[b], 0)
    await this.wait(frames)
    this.keys = 0
  }

  /** Press and release, then let the game see the release. */
  async press(button: Button, frames = 4) {
    await this.hold([button], frames)
    await this.wait(4)
  }

  /** Wait until `ok()` holds, checking every frame, or fail after `timeoutFrames`. */
  async until(ok: () => boolean, timeoutFrames: number, what: string) {
    for (let f = 0; f < timeoutFrames; f++) {
      if (ok()) return
      await this.wait(1)
    }
    throw new Error(`${this.name}: timed out waiting for ${what}`)
  }

  // ---------------------------------------------------------------- saves

  /** Upload the game's save if it changed (lib/client/save-sync.ts does the same for a browser). */
  async uploadSave(): Promise<boolean> {
    const bytes = this.gba?.save()
    if (!bytes || !this.slot || sha256(bytes) === this.savedHash) return false
    const res = await this.site.raw(`/api/slots/${this.slot.id}/saves`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-parent-version': this.versionId ?? 'none' },
      body: Buffer.from(bytes),
    })
    const body: { versionId: string; flagged?: number } = await res.json()
    this.versionId = body.versionId
    this.savedHash = sha256(bytes)
    this.log(`save uploaded${body.flagged ? ` (${body.flagged} flagged)` : ''}`)
    return true
  }

  // ---------------------------------------------------------------- link cable

  /** Ask a friend (bot or player) who is playing to plug in; they answer like any request. */
  async requestCable(friend: string) {
    if (this.air) throw new Error(`${this.name} has its wireless adapter on: the GBA has one serial port.`)
    const { friends } = await this.site.json<{ friends: Friend[] }>(`/api/cable/friends?slotId=${this.slot!.id}`)
    const f = friends.find((x) => x.username === friend.toLowerCase())
    if (!f) throw new Error(`${friend} is not a friend playing a game this one can link with.`)
    if (f.busy) throw new Error(`${friend} is already linked.`)
    await this.site.json('/api/cable', { method: 'POST', body: JSON.stringify({ slotId: this.slot!.id, friendId: f.userId }) })
  }

  /** Resolves once the cable is in (or fails after `timeoutMs`). */
  plugged(timeoutMs = 30_000): Promise<void> {
    if (this.cable) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: the cable never went in`)), timeoutMs)
      this.pluggedWaiters.push(() => {
        clearTimeout(t)
        resolve()
      })
    })
  }

  private async plugIn(sessionId: string) {
    const view = await this.site.json<LinkView>(`/api/link/${sessionId}`)
    const me = view.seats.find((s) => s.mine && s.slot?.id === this.slot?.id)
    const other = view.seats.find((s) => !s.mine)
    if (view.state !== 'ACTIVE' || !me || !other || !this.gba) return
    const peer = this.site.socket()
    const joined = await new Promise<boolean>((resolve) => peer.emit('link:join', sessionId, (r: { ok: boolean }) => resolve(!!r?.ok)))
    if (!joined) {
      peer.disconnect()
      throw new Error('could not join the relay')
    }
    peer.on('link:msg', (m: { t?: string; p?: number; k?: number; b?: number; n?: number }) => {
      if (m.t === 'c' && m.p !== me.seat && Number.isInteger(m.k) && Number.isInteger(m.b) && Number.isInteger(m.n)) this.gba?.putCable(m as { k: number; b: number; n: number })
    })
    peer.on('link:peer-left', () => {
      this.log(`${other.username} unplugged the cable`)
      this.cut()
    })
    peer.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') this.cut()
    })
    // As LinkCable.tsx: the parent's view of its child lags by a doubled round trip (ADR-021).
    const delay = Math.min(30, Math.ceil((2 * (await this.site.roundTrip())) / (1000 / GBA_FPS)) + 2)
    this.gba.plugCable(true, me.seat, delay)
    this.cable = { sessionId, seat: me.seat, with: other.username, peer }
    this.log(`cable plugged into ${other.username} (seat ${me.seat}, delay ${delay})`)
    const waiting = this.pluggedWaiters
    this.pluggedWaiters = []
    for (const w of waiting) w()
  }

  private cut() {
    if (!this.cable) return
    this.cable.peer.disconnect()
    this.gba?.plugCable(false)
    this.cable = null
  }

  async unplug() {
    if (!this.cable) return
    // End first: the relay treats a dropped socket as "disconnected" and would record that instead.
    await this.site.json(`/api/link/${this.cable.sessionId}`, { method: 'DELETE' }).catch(() => {})
    this.cut()
    this.log('cable unplugged')
  }

  // ---------------------------------------------------------------- wireless adapter (FR-35, ADR-022)

  /** Turn the adapter on and open a room; friends join with `inviteToRoom`. */
  async openRoom(): Promise<string> {
    if (this.cable) throw new Error(`${this.name} has a cable plugged in: the GBA has one serial port.`)
    const { id } = await this.site.json<{ id: string }>('/api/wireless', { method: 'POST', body: JSON.stringify({ slotId: this.slot!.id }) })
    await this.airOn(id)
    return id
  }

  /** Invite a friend (bot or player) who is playing into my room; a bot with autoAccept joins by itself. */
  async inviteToRoom(friend: string) {
    if (!this.air) throw new Error(`${this.name} is not in a wireless room.`)
    const { friends } = await this.site.json<{ friends: Friend[] }>(`/api/wireless/friends?slotId=${this.slot!.id}`)
    const f = friends.find((x) => x.username === friend.toLowerCase())
    if (!f) throw new Error(`${friend} is not a friend playing a game this room can invite.`)
    if (f.busy) throw new Error(`${friend} is busy.`)
    await this.site.json(`/api/wireless/${this.air.sessionId}/invite`, { method: 'POST', body: JSON.stringify({ friendId: f.userId }) })
  }

  async joinRoom(sessionId: string) {
    if (this.cable) throw new Error(`${this.name} has a cable plugged in: the GBA has one serial port.`)
    await this.site.json(`/api/wireless/${sessionId}/join`, { method: 'POST' })
    await this.airOn(sessionId)
  }

  /** As Wireless.tsx turnOn: adapter messages core ⇄ relay, as my room seat. */
  private async airOn(sessionId: string) {
    const view = await this.site.json<LinkView>(`/api/link/${sessionId}`)
    const me = view.seats.find((s) => s.mine && s.ready && !s.left && s.slot?.id === this.slot?.id)
    if (!me || !this.gba) throw new Error('could not turn the adapter on')
    const peer = this.site.socket()
    const joined = await new Promise<boolean>((resolve) => peer.emit('link:join', sessionId, (r: { ok: boolean }) => resolve(!!r?.ok)))
    if (!joined) {
      peer.disconnect()
      throw new Error('could not reach the room')
    }
    peer.on('link:msg', (m: { t?: string; p?: number; op?: number; to?: number; d?: number[] }) => {
      if (m.t !== 'a' || m.p === me.seat || !Number.isInteger(m.op) || !Number.isInteger(m.p) || (m.d && !Array.isArray(m.d))) return
      if (m.to === undefined || m.to === 255 || m.to === me.seat) this.gba?.putAir(m.op!, m.p!, m.d ?? [])
    })
    peer.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return
      this.log(`the connection to the site dropped (${reason}), so the adapter was turned off`)
      this.airOff()
    })
    this.gba.plugAir(true, me.seat)
    this.air = { sessionId, seat: me.seat, host: !!view.isHost, peer }
    this.log(`wireless adapter on in room ${sessionId} (seat ${me.seat}${view.isHost ? ', host' : ''})`)
  }

  private airOff() {
    if (!this.air) return
    this.gba?.plugAir(false, 0, true)
    this.air.peer.disconnect()
    this.air = null
  }

  /** Leave the room (the host closes it for everyone). */
  async leaveRoom() {
    const air = this.air
    if (!air) return
    this.air = null // from here on, room updates are about us leaving
    // Unplugging posts the adapter's goodbyes; send them before the socket goes (Wireless.tsx leave).
    this.gba?.plugAir(false, 0, true)
    for (const m of this.gba?.takeAir() ?? []) air.peer.emit('link:msg', air.sessionId, { t: 'a', p: air.seat, ...m })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await this.site.json(air.host ? `/api/link/${air.sessionId}` : `/api/wireless/${air.sessionId}/seat`, { method: 'DELETE' }).catch(() => {})
    air.peer.disconnect()
    this.log(air.host ? 'wireless room closed' : 'left the wireless room')
  }
}
