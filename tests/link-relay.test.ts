import type { Socket } from 'socket.io-client'
import { relayable } from '@/lib/link-relay'

const mine = new Set([1])

describe('relayable: cable (FR-34)', () => {
  it('passes Game Boy bytes and Gen 3 words from my own seat', () => {
    expect(relayable({ t: 'c', p: 1, k: 0, b: 0xff, n: 1 }, mine)).toBe(true)
    expect(relayable({ t: 'c', p: 1, k: 2, b: 0xffffffff, n: 2 }, mine)).toBe(true)
    expect(relayable({ t: 'c', p: 1, k: 3, b: 0, n: 3 }, mine)).toBe(true)
    expect(relayable({ t: 'c', p: 1, k: 4, b: 0xffff, n: 4 }, mine)).toBe(true)
  })
  it('refuses another seat, unknown kinds and out-of-range values', () => {
    expect(relayable({ t: 'c', p: 0, k: 0, b: 1, n: 1 }, mine)).toBe(false)
    expect(relayable({ t: 'c', p: 1, k: 5, b: 1, n: 1 }, mine)).toBe(false)
    expect(relayable({ t: 'c', p: 1, k: 0, b: 256, n: 1 }, mine)).toBe(false)
    expect(relayable({ t: 'c', p: 1, k: 4, b: 0x10000, n: 1 }, mine)).toBe(false)
    expect(relayable({ t: 'c', p: 1, k: 3, b: 1, n: 1 }, mine)).toBe(false)
    expect(relayable({ t: 'c', p: 1, k: 2, b: 1.5, n: 1 }, mine)).toBe(false)
  })
})

describe('relayable: wireless adapter (FR-35)', () => {
  it('passes adapter messages from my own seat to one seat or the room', () => {
    expect(relayable({ t: 'a', p: 1, op: 1, to: 255, d: [1, 2, 0xffffffff] }, mine)).toBe(true)
    expect(relayable({ t: 'a', p: 1, op: 6, to: 0, d: [] }, mine)).toBe(true)
    expect(relayable({ t: 'a', p: 1, op: 7, d: [] }, mine)).toBe(true)
  })
  it('refuses another seat, bad ops, bad targets and oversized or non-word data', () => {
    expect(relayable({ t: 'a', p: 0, op: 1, d: [] }, mine)).toBe(false)
    expect(relayable({ t: 'a', p: 1, op: 16, d: [] }, mine)).toBe(false)
    expect(relayable({ t: 'a', p: 1, op: 1, to: 15, d: [] }, mine)).toBe(true) // a room of 16 (ADR-024)
    expect(relayable({ t: 'a', p: 1, op: 1, to: 16, d: [] }, mine)).toBe(false)
    expect(relayable({ t: 'a', p: 1, op: 6, d: Array(25).fill(0) }, mine)).toBe(false)
    expect(relayable({ t: 'a', p: 1, op: 6, d: [-1] }, mine)).toBe(false)
    expect(relayable({ t: 'a', p: 1, op: 6, d: 'xx' }, mine)).toBe(false)
  })
})

describe('relay: a wireless room (ADR-024)', () => {
  afterEach(() => {
    for (const m of ['@/lib/db', '@/lib/link-sessions', '@/lib/wireless', '@/lib/realtime']) vi.doUnmock(m)
  })

  it('sends beacons to the whole room and a message to one adapter only to that page', async () => {
    vi.resetModules()
    const seatOf: Record<string, number> = { host: 0, ann: 1, bob: 2 }
    vi.doMock('@/lib/db', () => ({ prisma: {} }))
    vi.doMock('@/lib/link-sessions', () => ({
      endOrphanedLinks: async () => 0,
      endSession: async () => {},
      seatsOf: async (userId: string) => ({ state: 'ACTIVE', mode: 'WIRELESS', hostId: 'host', seats: [seatOf[userId]], userIds: Object.keys(seatOf) }),
    }))
    vi.doMock('@/lib/wireless', () => ({ leaveRoom: async () => {} }))
    vi.doMock('@/lib/realtime', () => ({ setPlaying: () => {} }))
    const { attachLinkRelay } = await import('@/lib/link-relay')
    const { createServer } = await import('http')
    const { Server } = await import('socket.io')
    const { io: connect } = await import('socket.io-client')

    const http = createServer()
    const server = new Server(http)
    server.use((socket, next) => {
      socket.data.userId = (socket.handshake.auth as { user: string }).user
      next()
    })
    attachLinkRelay(server)
    await new Promise<void>((r) => http.listen(0, r))
    const url = `http://localhost:${(http.address() as { port: number }).port}`
    const pages = Object.fromEntries(Object.keys(seatOf).map((user) => [user, connect(url, { transports: ['websocket'], auth: { user } })])) as Record<string, Socket>
    const got: Record<string, unknown[]> = { host: [], ann: [], bob: [] }
    for (const [user, s] of Object.entries(pages)) {
      s.on('link:msg', (m) => got[user].push(m))
      expect(await new Promise((r) => s.emit('link:join', 'room1', r))).toEqual({ ok: true, seats: [seatOf[user]] })
    }

    // Each page ends with a beacon: one page's messages arrive in order, so once its beacon is in, so is the rest.
    const beacon = (p: number) => ({ t: 'a', p, op: 1, to: 255, d: [1, 2, 3, 4, 5, 6, 7] })
    const data = { t: 'a', p: 1, op: 6, to: 0, d: [4, 0xabcd] }
    const nobody = { t: 'a', p: 2, op: 3, to: 9, d: [0x2001] } // a seat with no page: dropped
    pages.host.emit('link:msg', 'room1', beacon(0))
    pages.ann.emit('link:msg', 'room1', data)
    pages.ann.emit('link:msg', 'room1', beacon(1))
    pages.bob.emit('link:msg', 'room1', nobody)
    pages.bob.emit('link:msg', 'room1', beacon(2))
    const sorted = (ms: unknown[]) => [...ms].sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    await vi.waitFor(() => {
      expect(sorted(got.host)).toEqual(sorted([data, beacon(1), beacon(2)]))
      expect(sorted(got.ann)).toEqual(sorted([beacon(0), beacon(2)]))
      expect(sorted(got.bob)).toEqual(sorted([beacon(0), beacon(1)])) // not ann's data for the host
    })

    for (const s of Object.values(pages)) s.disconnect()
    server.close()
  })
})
