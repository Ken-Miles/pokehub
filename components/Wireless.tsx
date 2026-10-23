'use client'

import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { api } from '@/lib/client/api'
import type { EmulatorFrame } from '@/lib/client/emulator'
import { MAX_ROOM } from '@/lib/link-rules'

interface Friend { userId: string; username: string; game: string; busy: boolean }
interface Invite { sessionId: string; from: string }
interface Seat { seat: number; username: string; mine: boolean; ready: boolean; left: boolean; slot: { id: string; gameName: string } | null }
interface View { state: string; isHost: boolean; seats: Seat[] }
interface AirIn { t?: string; p?: number; op?: number; to?: number; d?: number[] }

/**
 * FR-35: the Gen 3 Wireless Adapter on the play page (ADR-022). Turning it on
 * opens (or joins) a room of up to MAX_ROOM players; only adapters in the room see
 * each other, so the Union Room and Wireless Club work between them. Games link in
 * groups of at most 5 inside the room, as on hardware (ADR-024). Each player runs
 * only their own game; this panel carries adapter messages between the emulator
 * iframe and the site relay.
 */
export function Wireless({
  slotId,
  emu,
  disabled,
  onOn,
}: {
  slotId: string
  emu: () => EmulatorFrame | null
  /** The link cable is plugged in: the GBA has one serial port. */
  disabled: boolean
  onOn: (on: boolean) => void
}) {
  const [room, setRoom] = useState<{ id: string; view: View } | null>(null)
  const [invite, setInvite] = useState<Invite | null>(null)
  const [friends, setFriends] = useState<Friend[]>([])
  const [error, setError] = useState('')
  const off = useRef<() => void>(() => {})
  const roomId = useRef<string | null>(null)

  const refresh = async (id: string) => {
    const view = await api<View>(`/api/link/${id}`)
    if (roomId.current !== id) return // left meanwhile
    if (view.state === 'ENDED' || !view.seats.some((s) => s.mine && !s.left)) {
      off.current()
      if (view.state === 'ENDED') setError('The room was closed.')
      return
    }
    setRoom({ id, view })
    // Who can be invited changes with the room (someone left: invitable again).
    api<{ friends: Friend[] }>(`/api/wireless/friends?slotId=${slotId}`).then((r) => setFriends(r.friends)).catch(() => {})
  }

  // Invites, and room changes (someone joined, left, or the host closed it).
  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    socket.on('air:invite', (r: Invite & { slotId: string }) => {
      if (r.slotId === slotId) setInvite({ sessionId: r.sessionId, from: r.from })
    })
    socket.on('link:updated', (r: { sessionId: string }) => {
      if (r.sessionId === roomId.current) void refresh(r.sessionId).catch(() => {})
      setInvite((q) => (q?.sessionId === r.sessionId && !roomId.current ? null : q))
    })
    return () => {
      socket.disconnect()
      off.current()
    }
    // refresh only reads refs and stable setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId])

  // Friends a member could invite, while the adapter is on.
  useEffect(() => {
    if (!room) return
    const load = () => void api<{ friends: Friend[] }>(`/api/wireless/friends?slotId=${slotId}`).then((r) => setFriends(r.friends)).catch(() => {})
    load()
    const timer = window.setInterval(load, 10_000)
    return () => window.clearInterval(timer)
  }, [slotId, room?.id]) // eslint-disable-line react-hooks/exhaustive-deps

  /** On the air: adapter messages iframe ⇄ relay, as this page's room seat. */
  async function turnOn(id: string) {
    const view = await api<View>(`/api/link/${id}`)
    const me = view.seats.find((s) => s.mine && s.ready && !s.left && s.slot?.id === slotId)
    const e = emu()
    if (!me || !e) throw new Error('Could not turn the adapter on. Try again.')
    const peer: Socket = io({ path: '/socket.io' })
    const joined = await new Promise<boolean>((resolve) => peer.emit('link:join', id, (r: { ok: boolean }) => resolve(!!r?.ok)))
    if (!joined) {
      peer.disconnect()
      throw new Error('Could not reach the room. Try again.')
    }
    const stop = e.on('air', (m) => peer.emit('link:msg', id, { t: 'a', p: me.seat, op: m.op, to: m.to, d: m.d }))
    // The site restarted or the network dropped: the relay forgot us, so the adapter is off.
    peer.on('disconnect', (reason) => {
      if (reason === 'io client disconnect') return // our own leave
      off.current()
      setError('The connection to the site dropped, so the adapter was turned off. Turn it on again.')
    })
    peer.on('link:msg', (m: AirIn) => {
      if (m.t !== 'a' || m.p === me.seat) return
      if (m.to === undefined || m.to === 255 || m.to === me.seat) e.send({ type: 'air', op: m.op, from: m.p, d: m.d ?? [] })
    })
    off.current = () => {
      stop()
      peer.disconnect()
      e.send({ type: 'air-plug', on: false, quiet: true })
      roomId.current = null
      setRoom(null)
      setFriends([])
      onOn(false)
      off.current = () => {}
    }
    roomId.current = id
    e.send({ type: 'air-plug', on: true, seat: me.seat })
    setRoom({ id, view })
    setInvite(null)
    setError('')
    onOn(true)
  }

  const act = (fn: () => Promise<unknown>) => () => {
    setError('')
    void fn().catch((err) => setError((err as Error).message))
  }

  const open = act(async () => turnOn((await api<{ id: string }>('/api/wireless', { method: 'POST', body: JSON.stringify({ slotId }) })).id))
  const accept = act(async () => {
    await api(`/api/wireless/${invite!.sessionId}/join`, { method: 'POST' })
    await turnOn(invite!.sessionId)
  })
  const decline = act(async () => {
    await api(`/api/wireless/${invite!.sessionId}/seat`, { method: 'DELETE' })
    setInvite(null)
  })
  const ask = (f: Friend) => act(() => api(`/api/wireless/${room!.id}/invite`, { method: 'POST', body: JSON.stringify({ friendId: f.userId }) }))
  const leave = act(async () => {
    const r = room!
    roomId.current = null // room updates from here on are about us leaving
    // Unplugging posts the adapter's own goodbyes; let them reach the relay before the socket goes.
    emu()?.send({ type: 'air-plug', on: false, quiet: true })
    await new Promise((resolve) => setTimeout(resolve, 200))
    await api(r.view.isHost ? `/api/link/${r.id}` : `/api/wireless/${r.id}/seat`, { method: 'DELETE' }).catch(() => {})
    off.current()
  })

  const members = room?.view.seats.filter((s) => !s.left) ?? []
  const invitable = friends.filter((f) => !members.some((s) => s.username === f.username))
  return (
    <section className="rounded-xl border border-line bg-card p-4 text-sm">
      <h2 className="font-semibold">Wireless Adapter</h2>
      {disabled && !room ? (
        <p className="mt-2 text-muted">Unplug the link cable to use the Wireless Adapter.</p>
      ) : room ? (
        <>
          <p className="mt-2">
            On, in a room of up to {MAX_ROOM} players. Go upstairs in a Pokémon Center to the Union Room or the Wireless Club;
            trades, battles, chats and minigames link up to 5 of you at a time.{' '}
            <button className="underline" onClick={leave}>{room.view.isHost ? 'Close the room' : 'Leave the room'}</button>
          </p>
          <ul className="mt-2 space-y-1">
            {members.map((s) => (
              <li key={s.seat}>
                {s.username}
                {s.mine ? ' (you)' : ''} · {s.slot?.gameName ?? '—'}
                {!s.ready && <span className="text-muted"> · invited</span>}
              </li>
            ))}
          </ul>
          {members.length < MAX_ROOM && invitable.length > 0 && (
            <ul className="mt-2 space-y-1">
              {invitable.map((f) => (
                <li key={f.userId} className="flex items-center justify-between gap-3">
                  <span className="text-muted">{f.username} · {f.game}</span>
                  <button className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={f.busy} onClick={ask(f)}>
                    {f.busy ? 'Busy' : 'Invite'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        <>
          {invite && (
            <p className="mt-2">
              <strong>{invite.from}</strong> invited you to a wireless room.{' '}
              <button className="rounded bg-accent px-2 py-1 font-medium text-white" onClick={accept}>Join</button>{' '}
              <button className="underline" onClick={decline}>Decline</button>
            </p>
          )}
          <p className="mt-2">
            <button className="rounded border border-line px-2 py-1" onClick={open}>Turn on and open a room</button>
          </p>
        </>
      )}
      {error && <p className="mt-2 text-danger">{error}</p>}
    </section>
  )
}
