'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { io, type Socket } from 'socket.io-client'

interface Screen {
  url: string
  status: string
  at: number
}

/** A bot that sent nothing for this long has stopped, or its host has. */
const STALE_MS = 3000

// Button bits (bots/core.ts KEY), on the emulator's default keys (public/emulator/player.js); X and Y only reach a DS.
// shortcut: ignores an admin's own remapped controls; read them from /api/account/controls if anyone asks.
// shortcut: no touch screen; send hub_touch positions as a bot:touch event if an admin needs to tap.
const KEYBOARD: Record<string, number> = { KeyX: 1, KeyZ: 2, Backspace: 4, Enter: 8, ArrowRight: 16, ArrowLeft: 32, ArrowUp: 64, ArrowDown: 128, KeyS: 256, KeyA: 512, KeyW: 1024, KeyQ: 2048 }
const PAD: { label: string; name: string; bit: number }[][] = [
  [{ label: 'L', name: 'L', bit: 512 }, { label: 'R', name: 'R', bit: 256 }],
  [{ label: '←', name: 'Left', bit: 32 }, { label: '↑', name: 'Up', bit: 64 }, { label: '↓', name: 'Down', bit: 128 }, { label: '→', name: 'Right', bit: 16 }],
  [{ label: 'Select', name: 'Select', bit: 4 }, { label: 'Start', name: 'Start', bit: 8 }],
  [{ label: 'Y', name: 'Y (DS)', bit: 2048 }, { label: 'X', name: 'X (DS)', bit: 1024 }, { label: 'B', name: 'B', bit: 2 }, { label: 'A', name: 'A', bit: 1 }],
]

/**
 * FR-36: watch the running bots' screens live (lib/bot-watch.ts). Bots only send
 * while this page is open. One admin at a time can take control of a bot and press
 * its buttons; the bot's own commands wait meanwhile. Commands go through the bot
 * host (`npm run bots`).
 */
export default function AdminBotsPage() {
  const [screens, setScreens] = useState<Record<string, Screen>>({})
  const [error, setError] = useState('')
  const [now, setNow] = useState(() => Date.now())
  const [mine, setMine] = useState<string | null>(null) // the bot I control
  const socketRef = useRef<Socket | null>(null)
  const mineRef = useRef<string | null>(null)
  const keysRef = useRef(0)

  const setKeys = useCallback((keys: number) => {
    if (keys === keysRef.current || !mineRef.current) return
    keysRef.current = keys
    socketRef.current?.emit('bot:keys', mineRef.current, keys)
  }, [])
  const press = useCallback((bit: number, down: boolean) => setKeys(down ? keysRef.current | bit : keysRef.current & ~bit), [setKeys])

  function control(bot: string, on: boolean) {
    setError('')
    socketRef.current?.emit('bot:control', bot, on, (r: { ok: boolean; message?: string }) => {
      if (!r?.ok) return setError(r?.message ?? 'Could not take control.')
      keysRef.current = 0
      mineRef.current = on ? bot : null
      setMine(mineRef.current)
    })
  }

  // The keyboard drives the bot I control; leaving the window lets go of everything.
  useEffect(() => {
    if (!mine) return
    const onKey = (e: KeyboardEvent) => {
      const bit = KEYBOARD[e.code]
      if (!bit) return
      e.preventDefault()
      press(bit, e.type === 'keydown')
    }
    const letGo = () => setKeys(0)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('blur', letGo)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('blur', letGo)
    }
  }, [mine, press, setKeys])

  useEffect(() => {
    const socket = io({ path: '/socket.io' })
    socketRef.current = socket
    // On every connect: a reconnected socket has lost its rooms on the server.
    socket.on('connect', () =>
      socket.emit('bots:watch', true, (r: { ok: boolean }) => setError(r?.ok ? '' : 'Only admins can watch bots.')),
    )
    // The site hands control back when this socket drops.
    socket.on('disconnect', () => {
      mineRef.current = null
      setMine(null)
    })
    socket.on('bot:screen', (m: { bot: string; png: ArrayBuffer; status: string }) => {
      const url = URL.createObjectURL(new Blob([m.png], { type: 'image/png' }))
      setScreens((s) => {
        if (s[m.bot]) URL.revokeObjectURL(s[m.bot].url)
        return { ...s, [m.bot]: { url, status: m.status, at: Date.now() } }
      })
    })
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(tick)
      socket.disconnect()
      setScreens((s) => {
        for (const v of Object.values(s)) URL.revokeObjectURL(v.url)
        return {}
      })
    }
  }, [])

  const bots = Object.keys(screens).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Live screens of the running bots. Start and command them from the bot host (<code>npm run bots</code>).
      </p>
      {error && <p className="text-sm text-danger">{error}</p>}
      {!bots.length && !error && <p className="text-sm text-muted">No bots are running.</p>}
      <div className="flex flex-wrap gap-6">
        {bots.map((name) => {
          const s = screens[name]
          const stale = now - s.at > STALE_MS
          return (
            <figure key={name} className="space-y-1">
              <img
                src={s.url}
                alt={`${name}'s screen`}
                height={320}
                className={`h-80 w-auto max-w-full rounded-md border border-line ${stale ? 'opacity-40' : ''}`}
                style={{ imageRendering: 'pixelated' }}
              />
              <figcaption className="text-sm">
                <span className="font-medium">{name}</span>{' '}
                <span className="font-mono text-muted">{stale ? 'not sending (stopped?)' : s.status}</span>
              </figcaption>
              <button
                onClick={() => control(name, mine !== name)}
                disabled={!!mine && mine !== name}
                className="rounded-md border border-line px-3 py-1.5 text-sm disabled:opacity-40"
              >
                {mine === name ? 'Give back control' : 'Take control'}
              </button>
              {mine === name && (
                <div className="space-y-2">
                  <div className="flex flex-wrap gap-4">
                    {PAD.map((group, i) => (
                      <div key={i} className="flex gap-1">
                        {group.map((b) => (
                          <button
                            key={b.name}
                            aria-label={b.name}
                            onPointerDown={(e) => {
                              e.currentTarget.setPointerCapture(e.pointerId)
                              press(b.bit, true)
                            }}
                            onPointerUp={() => press(b.bit, false)}
                            onPointerCancel={() => press(b.bit, false)}
                            onContextMenu={(e) => e.preventDefault()}
                            className="min-w-11 touch-none select-none rounded-md border border-line bg-card px-3 py-2 text-sm font-medium active:bg-accent active:text-white"
                          >
                            {b.label}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                  <p className="text-xs text-muted">Keys: arrows, X = A, Z = B, A = L, S = R, Enter = Start, Backspace = Select.</p>
                </div>
              )}
            </figure>
          )
        })}
      </div>
    </div>
  )
}
