'use client'

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message)
  }
}

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: init?.body && !(init.body instanceof ArrayBuffer) ? { 'content-type': 'application/json', ...init?.headers } : init?.headers,
  })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? res.statusText)
  }
  return res.status === 204 ? (undefined as T) : res.json()
}

export function formatPlayTime(seconds: number): string {
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

/** "just now", "5 min ago", "3 h ago", then the date (FR-10 slot card). */
export function formatSyncedAt(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - new Date(iso).getTime()) / 60_000)
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes} min ago`
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`
  return new Date(iso).toLocaleDateString()
}

/** Median of five round trips from this browser to the site (a tiny static file, never cached). */
export async function siteRoundTrip(): Promise<number> {
  const times: number[] = []
  for (let i = 0; i < 5; i++) {
    const t = performance.now()
    await fetch('/emulator/core/build.json', { cache: 'no-store' })
    times.push(performance.now() - t)
  }
  return times.sort((a, b) => a - b)[2]
}
