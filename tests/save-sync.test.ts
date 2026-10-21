import { SaveSync } from '@/lib/client/save-sync'
import { fakeFetch, fakeSave, memoryQueue, statuses } from './helpers/client-sync'

/** FR-08: the browser's save sync — queue, retries, conflicts (ADR-006). */
function setup(replies?: Parameters<typeof fakeFetch>[0]) {
  const queue = memoryQueue()
  const net = fakeFetch(replies)
  const st = statuses()
  const sync = new SaveSync({ slotId: 's1', platform: 'GBA', queue, fetch: net.fetch, onStatus: st.onStatus })
  return { queue, net, st, sync }
}

afterEach(() => {
  vi.useRealTimers()
})

describe('SaveSync uploads', () => {
  it('uploads with the current version as parent, then chains on the new one', async () => {
    const { sync, net, st, queue } = setup()
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    await sync.submit(fakeSave(2))
    expect(net.requests.map((r) => r.headers['x-parent-version'])).toEqual(['v0', 'v1'])
    expect(net.requests[0].url).toBe('/api/slots/s1/saves')
    expect(st.last()).toEqual({ state: 'synced', flagged: false })
    expect(queue.items.size).toBe(0)
    expect(sync.owns('v2')).toBe(true)
    expect(sync.owns('elsewhere')).toBe(false)
  })

  it('reports Pokémon flagged by the registry', async () => {
    const { sync, st } = setup([{ status: 201, body: { versionId: 'v1', flagged: 2 } }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    expect(st.last()).toEqual({ state: 'synced', flagged: true })
  })

  it('a save made during an upload goes next, built on the new version', async () => {
    const queue = memoryQueue()
    const net = fakeFetch()
    let release!: () => void
    const held = new Promise<void>((r) => (release = r))
    let calls = 0
    // Hold the first upload open until the second save has been submitted.
    const gated = (async (url: RequestInfo | URL, init?: RequestInit) => {
      if (calls++ === 0) await held
      return net.fetch(url, init)
    }) as typeof fetch
    const sync = new SaveSync({ slotId: 's1', platform: 'GBA', queue, fetch: gated, onStatus: () => {} })
    await sync.boot('v0', null)

    const first = sync.submit(fakeSave(1))
    await vi.waitFor(() => expect(calls).toBe(1))
    const firstSha = (await queue.get('s1'))!.sha256
    const second = sync.submit(fakeSave(2)) // joins the pump already running
    await vi.waitFor(async () => expect((await queue.get('s1'))?.sha256).not.toBe(firstSha))
    release()
    await Promise.all([first, second])
    expect(net.requests.map((r) => r.headers['x-parent-version'])).toEqual(['v0', 'v1'])
    expect(new Uint8Array(net.requests[1].body as ArrayBuffer)).toEqual(new Uint8Array(fakeSave(2)))
    expect(queue.items.size).toBe(0)
  })
})

describe('SaveSync offline', () => {
  it('keeps the save queued and retries with backoff until it lands', async () => {
    vi.useFakeTimers()
    const { sync, net, st, queue } = setup(['network-error', 'network-error', { status: 201, body: { versionId: 'v1' } }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    expect(st.last()?.state).toBe('offline')
    expect(queue.items.size).toBe(1)

    await vi.advanceTimersByTimeAsync(4_999)
    expect(net.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(net.requests).toHaveLength(2) // after 5 s
    await vi.advanceTimersByTimeAsync(9_999)
    expect(net.requests).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(1)
    expect(net.requests).toHaveLength(3) // after another 10 s
    expect(st.last()).toEqual({ state: 'synced', flagged: false })
    expect(queue.items.size).toBe(0)
  })

  it('only the newest save is kept while offline', async () => {
    vi.useFakeTimers()
    const { sync, net } = setup(['network-error', { status: 201, body: { versionId: 'v1' } }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    await sync.submit(fakeSave(2)) // still waiting for the retry timer
    await sync.retryNow() // Sync now / back online
    const sent = net.requests.filter((r) => r.body instanceof ArrayBuffer).at(-1)!
    expect(new Uint8Array(sent.body as ArrayBuffer)).toEqual(new Uint8Array(fakeSave(2)))
  })

  it('treats server errors, rate limits and a lost login as retryable', async () => {
    for (const status of [500, 503, 429, 401]) {
      vi.useFakeTimers()
      const { sync, st, queue } = setup([{ status }])
      await sync.boot('v0', null)
      await sync.submit(fakeSave(1))
      expect(st.last()?.state).toBe('offline')
      expect(queue.items.size).toBe(1)
      sync.dispose()
      vi.useRealTimers()
    }
  })
})

describe('SaveSync stops', () => {
  it('409: this tab is stale — stops and sends nothing more', async () => {
    const { sync, net, st } = setup([{ status: 409, body: { error: 'stale_parent' } }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    await sync.submit(fakeSave(2))
    expect(st.last()).toEqual({ state: 'conflict' })
    expect(net.requests).toHaveLength(1)
  })

  it('423: a trade holds the slot', async () => {
    const { sync, st } = setup([{ status: 423 }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    expect(st.last()).toEqual({ state: 'locked' })
  })

  it('422: a save that will never be accepted is dropped with the reason', async () => {
    const { sync, st, queue } = setup([{ status: 422, body: { message: 'That save belongs to a different game.' } }])
    await sync.boot('v0', null)
    await sync.submit(fakeSave(1))
    expect(st.last()).toEqual({ state: 'rejected', message: 'That save belongs to a different game.' })
    expect(queue.items.size).toBe(0)
  })
})

describe('SaveSync boot', () => {
  it('starts from the cloud save when nothing is waiting', async () => {
    const { sync } = setup()
    const cloud = fakeSave(9)
    expect(await sync.boot('v3', cloud)).toEqual({ save: cloud })
  })

  it("resumes this device's unsent save when the cloud hasn't moved", async () => {
    const { sync, queue, net } = setup([{ status: 201, body: { versionId: 'v4' } }])
    const pending = { slotId: 's1', bytes: fakeSave(5), sha256: 'p', parent: 'v3', savedAt: 1 }
    await queue.put(pending)
    expect(await sync.boot('v3', fakeSave(9))).toEqual({ save: pending.bytes })
    await sync.idle()
    expect(net.requests.map((r) => r.headers['x-parent-version'])).toEqual(['v3'])
    expect(queue.items.size).toBe(0)
  })

  it('shows a conflict, sends nothing, when the cloud moved since', async () => {
    const { sync, queue, net, st } = setup()
    const pending = { slotId: 's1', bytes: fakeSave(5), sha256: 'p', parent: 'v2', savedAt: 1 }
    await queue.put(pending)
    expect(await sync.boot('v3', fakeSave(9))).toEqual({ conflict: pending })
    await sync.submit(fakeSave(6))
    expect(net.requests).toHaveLength(0)
    expect(st.last()).toEqual({ state: 'conflict' })

    await sync.discardPending()
    expect(queue.items.size).toBe(0)
    expect(await sync.boot('v3', null)).toEqual({ save: null })
  })
})
