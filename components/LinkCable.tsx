'use client'

import { useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'
import { api, siteRoundTrip } from '@/lib/client/api'
import type { EmulatorFrame } from '@/lib/client/emulator'

interface Friend { userId: string; username: string; game: string; busy: boolean }
interface Request { sessionId: string; from: string }
interface View { mode: string; state: string; seats: { seat: number; username: string; mine: boolean; slot: { id: string } | null }[] }

/**
 * FR-34: the link cable on the play page. Each player runs only their own game;
 * this panel plugs it into a friend's running game and carries cable messages
 * between the emulator iframe and the site relay (Game Boy ADR-020, Gen 3 ADR-021).
 */
export function LinkCable({
  slotId,
  emu,
  onPlugged,
  disabled = false,
}: {
  slotId: string
  emu: () => EmulatorFrame | null
  onPlugged: (on: boolean) => void
  /** The Wireless Adapter is on: the GBA has one serial port. */
  disabled?: boolean
}) {
  const [friends, setFriends] = useState<Friend[]>([])
  const [request, setRequest] = useState<Request | null>(null)
  const [plugged, setPlugged] = useState<{ sessionId: string; with: string } | null>(null)
  const [waiting, setWaiting] = useState('')
  const [error, setError] = useState('')
  const relay = useRef<Socket | null>(null)
  const cut = useRef<() => void>(() => {})

  // Friends playing a game this cable fits; refreshed while nothing is plugged in.
  useEffect(() => {
    if (plugged) return
    const load = () => void api<{ friends: Friend[] }>(`/api/cable/friends?slotId=${slotId}`).then((r) => setFriends(r.friends)).catch(() => {})
    load()
    const timer = window.setInterval(load, 10_000)
    return () => window.clearInterval(timer)
  }, [slotId, plugged])

  // Requests from friends, and the moment the cable goes in.
  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    socket.on('cable:request', (r: Request & { slotId: string }) => {
      if (r.slotId === slotId) setRequest({ sessionId: r.sessionId, from: r.from })
    })
    socket.on('cable:plugged', (r: { sessionId: string }) => void plugIn(r.sessionId))
    socket.on('link:updated', (r: { sessionId: string }) => {
      setRequest((q) => (q?.sessionId === r.sessionId ? null : q)) // withdrawn or answered elsewhere
      setWaiting('')
    })
    return () => {
      socket.disconnect()
      cut.current()
    }
    // plugIn only reads refs and stable setters
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slotId])

  async function plugIn(sessionId: string) {
    try {
      const view = await api<View>(`/api/link/${sessionId}`)
      const me = view.seats.find((s) => s.mine && s.slot?.id === slotId) // not another of my tabs
      if (view.state !== 'ACTIVE') return
      const other = view.seats.find((s) => !s.mine)
      const e = emu()
      if (!me || !other || !e) return
      const peer = io({ path: '/socket.io' })
      relay.current = peer
      const joined = await new Promise<boolean>((resolve) => peer.emit('link:join', sessionId, (r: { ok: boolean }) => resolve(!!r?.ok)))
      if (!joined) throw new Error('Could not connect the cable. Try again.')
      // Cable bytes: iframe → relay → the friend's iframe, and back.
      const off = e.on('cable', (m) => peer.emit('link:msg', sessionId, { t: 'c', p: me.seat, k: m.k, b: m.b, n: m.n }))
      peer.on('link:msg', (m: { t?: string; p?: number; k?: number; b?: number; n?: number }) => {
        if (m.t === 'c' && m.p !== me.seat) e.send({ type: 'cable', k: m.k, b: m.b, n: m.n })
      })
      cut.current = () => {
        off()
        peer.disconnect()
        relay.current = null
        e.send({ type: 'cable-plug', on: false })
        setPlugged(null)
        onPlugged(false)
        cut.current = () => {}
      }
      peer.on('link:peer-left', () => {
        cut.current()
        setError(`${other.username} unplugged the cable.`)
      })
      // The site restarted or the network dropped: the relay forgot us, so the cable is out.
      peer.on('disconnect', (reason) => {
        if (reason === 'io client disconnect') return // our own unplug
        cut.current()
        setError('The connection to the site dropped, so the cable was unplugged. Plug in again.')
      })
      // Gen 3 (ADR-021): the parent holds its child's words back by `delay` frames; the cable
      // runs through the relay, so a word crosses it twice per round. Game Boy ignores both.
      const delay = Math.min(30, Math.ceil((2 * (await siteRoundTrip())) / (1000 / 59.7275)) + 2)
      e.send({ type: 'cable-plug', on: true, seat: me.seat, delay })
      setPlugged({ sessionId, with: other.username })
      setRequest(null)
      setWaiting('')
      setError('')
      onPlugged(true)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function ask(f: Friend) {
    setError('')
    try {
      await api('/api/cable', { method: 'POST', body: JSON.stringify({ slotId, friendId: f.userId }) })
      setWaiting(f.username)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function answer(accept: boolean) {
    if (!request) return
    setError('')
    try {
      if (accept) await api(`/api/cable/${request.sessionId}/accept`, { method: 'POST' })
      else await api(`/api/link/${request.sessionId}`, { method: 'DELETE' })
      setRequest(null)
    } catch (err) {
      setError((err as Error).message)
    }
  }

  async function unplug() {
    if (!plugged) return
    // End first: the relay treats a dropped socket as "disconnected" and would record that instead.
    await api(`/api/link/${plugged.sessionId}`, { method: 'DELETE' }).catch(() => {})
    cut.current()
  }

  return (
    <section className="rounded-xl border border-line bg-card p-4 text-sm">
      <h2 className="font-semibold">Link cable</h2>
      {disabled && !plugged ? (
        <p className="mt-2 text-muted">Turn the Wireless Adapter off to use the link cable.</p>
      ) : plugged ? (
        <p className="mt-2">
          Plugged into <strong>{plugged.with}</strong>&rsquo;s game. Go to the Cable Club in a Pokémon Center to trade.{' '}
          <button className="underline" onClick={() => void unplug()}>Unplug</button>
        </p>
      ) : (
        <>
          {request && (
            <p className="mt-2">
              <strong>{request.from}</strong> wants to link cables.{' '}
              <button className="rounded bg-accent px-2 py-1 font-medium text-white" onClick={() => void answer(true)}>Accept</button>{' '}
              <button className="underline" onClick={() => void answer(false)}>Decline</button>
            </p>
          )}
          {waiting && <p className="mt-2 text-muted">Waiting for {waiting} to accept…</p>}
          {friends.length === 0 ? (
            <p className="mt-2 text-muted">No friends are playing a game this one can link with right now.</p>
          ) : (
            <ul className="mt-2 space-y-1">
              {friends.map((f) => (
                <li key={f.userId} className="flex items-center justify-between gap-3">
                  <span>{f.username} · {f.game}</span>
                  <button className="rounded border border-line px-2 py-1 disabled:opacity-50" disabled={f.busy || !!waiting} onClick={() => void ask(f)}>
                    {f.busy ? 'Already linked' : 'Plug in'}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      )}
      {error && <p className="mt-2 text-danger">{error}</p>}
    </section>
  )
}
