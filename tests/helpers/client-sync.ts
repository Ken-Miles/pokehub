import type { PendingSave, SaveQueue, SyncStatus } from '@/lib/client/save-sync'

/** In-memory stand-in for the IndexedDB queue. */
export function memoryQueue(): SaveQueue & { items: Map<string, PendingSave> } {
  const items = new Map<string, PendingSave>()
  return {
    items,
    async get(slotId) {
      return items.get(slotId) ?? null
    },
    async put(save) {
      items.set(save.slotId, save)
    },
    async delete(slotId, sha256) {
      const current = items.get(slotId)
      if (current && (sha256 === undefined || current.sha256 === sha256)) items.delete(slotId)
    },
    async rebase(slotId, parent) {
      const current = items.get(slotId)
      if (current) items.set(slotId, { ...current, parent })
    },
  }
}

export interface Recorded {
  url: string
  method: string
  headers: Record<string, string>
  body: ArrayBuffer | string | null
}

type Reply = { status: number; body?: unknown } | 'network-error'

/**
 * A fetch that records every request and answers from `replies` in order
 * (the last one repeats). Default: each upload becomes version v1, v2, …
 */
export function fakeFetch(replies: Reply[] = []) {
  const requests: Recorded[] = []
  let n = 0
  const fn = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = init.body
    requests.push({
      url: String(input),
      method: init.method ?? 'GET',
      headers: { ...(init.headers as Record<string, string>) },
      body: body instanceof ArrayBuffer ? body.slice(0) : typeof body === 'string' ? body : null,
    })
    n++
    const reply = replies.length ? replies[Math.min(n - 1, replies.length - 1)] : { status: 201, body: { versionId: `v${n}` } }
    if (reply === 'network-error') throw new TypeError('Failed to fetch')
    return new Response(reply.body === undefined ? null : JSON.stringify(reply.body), { status: reply.status })
  }
  return { fetch: fn as typeof fetch, requests }
}

export function statuses() {
  const seen: SyncStatus[] = []
  return { seen, onStatus: (s: SyncStatus) => seen.push(s), last: () => seen.at(-1) }
}

/** A 128 KB save whose bytes depend on `seed`. */
export function fakeSave(seed: number, size = 0x20000): ArrayBuffer {
  const b = new Uint8Array(size)
  for (let i = 0; i < size; i++) b[i] = (i * 31 + seed * 7) & 0xff
  return b.buffer
}
