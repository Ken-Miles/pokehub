import { PLATFORMS, isAcceptedSaveSize, type Platform } from '@/lib/games'
import { hasGbRomHeader, hasGbaRomHeader } from '@/lib/rom-header'

export { hasGbaRomHeader }

/**
 * Browser side of cloud saves (FR-08). Framework-free so it is unit-tested
 * (tests/save-sync.test.ts) with a fake fetch and an in-memory queue.
 *
 * - The newest unsent save per slot is kept in a queue (IndexedDB in the app),
 *   so closing the tab or losing the network never loses it. Saves are whole
 *   snapshots, so only the newest one matters.
 * - Every upload names the version it was built on (ADR-006). 409 = this tab is
 *   stale; 423 = a trade holds the slot. Both stop syncing.
 * - Nothing that isn't save-sized is ever sent (NFR-01): a game file passed in
 *   by mistake is refused here, before any request.
 */

export interface PendingSave {
  slotId: string
  bytes: ArrayBuffer
  sha256: string
  /** The cloud version this save was built on. */
  parent: string
  savedAt: number
}

export interface SaveQueue {
  get(slotId: string): Promise<PendingSave | null>
  put(save: PendingSave): Promise<void>
  /** Delete the slot's pending save — only if it is still `sha256`, when given. Atomic. */
  delete(slotId: string, sha256?: string): Promise<void>
  /** Re-point the slot's pending save (if any) at a new cloud version. Atomic. */
  rebase(slotId: string, parent: string): Promise<void>
}

export type SyncStatus =
  | { state: 'synced'; flagged: boolean }
  | { state: 'syncing' }
  | { state: 'offline'; retryAt: number }
  | { state: 'conflict' }
  | { state: 'locked' }
  | { state: 'rejected'; message: string }

export type BootResult = { save: ArrayBuffer | null } | { conflict: PendingSave }

const RETRY_BASE_MS = 5_000
const RETRY_MAX_MS = 60_000

/**
 * Null if `bytes` can be uploaded as a save for this platform, else why not.
 * Refuses anything not save-sized, and anything carrying a GBA or Game Boy game
 * header (a slice of a game file), so game-file bytes never go out (NFR-01).
 */
export function saveProblem(platform: Platform, bytes: ArrayBuffer): string | null {
  const name = PLATFORMS[platform].name
  if (!isAcceptedSaveSize(platform, bytes.byteLength)) return `That isn't a ${name} save file, so it wasn't uploaded.`
  const b = new Uint8Array(bytes)
  if (hasGbaRomHeader(b) || hasGbRomHeader(b)) return 'That is a game file, not a save. Game files never leave your device.'
  return null
}

/** The only thing sent about a game file (FR-05): which game, and its hash. */
export function romCheck(rom: { platform: Platform; code: string; sha1: string }): { platform: Platform; code: string; sha1: string } {
  return { platform: rom.platform, code: rom.code, sha1: rom.sha1 }
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

export class SaveSync {
  private versionId = 'none'
  private mine = new Set<string>()
  private pumping: Promise<void> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private flagged = false
  private halted = false

  constructor(
    private o: {
      slotId: string
      platform: Platform
      queue: SaveQueue
      onStatus: (s: SyncStatus) => void
      fetch?: typeof fetch
    },
  ) {}

  /**
   * Decide which save the emulator starts from. A save left unsent by an
   * earlier visit wins if the cloud hasn't moved since; if it has, the player
   * must choose (the caller shows the conflict).
   */
  async boot(serverVersionId: string, serverSave: ArrayBuffer | null): Promise<BootResult> {
    this.versionId = serverVersionId
    const pending = await this.o.queue.get(this.o.slotId)
    if (!pending) {
      this.status({ state: 'synced', flagged: false })
      return { save: serverSave }
    }
    if (pending.parent !== serverVersionId) {
      this.halted = true
      this.status({ state: 'conflict' })
      return { conflict: pending }
    }
    void this.pump()
    return { save: pending.bytes }
  }

  /** Drop this device's unsent save and go with the cloud (after a boot conflict). */
  async discardPending(): Promise<void> {
    await this.o.queue.delete(this.o.slotId)
    this.halted = false
    this.status({ state: 'synced', flagged: false })
  }

  /** A save the emulator just wrote. */
  async submit(bytes: ArrayBuffer): Promise<void> {
    if (this.halted) return
    const problem = saveProblem(this.o.platform, bytes)
    if (problem) return this.status({ state: 'rejected', message: problem })
    const save: PendingSave = {
      slotId: this.o.slotId,
      bytes,
      sha256: await sha256Hex(bytes),
      parent: this.versionId,
      savedAt: Date.now(),
    }
    await this.o.queue.put(save)
    await this.pump()
  }

  /** "Sync now", or the browser came back online. */
  retryNow(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    this.attempts = 0
    return this.pump()
  }

  /** Stop for good: another tab, a restore or a trade moved the slot on. */
  halt(state: 'conflict' | 'locked'): void {
    this.halted = true
    if (this.timer) clearTimeout(this.timer)
    this.status({ state })
  }

  /** Whether a version came from this tab (so its slot:updated echo is ignored). */
  owns(versionId: string): boolean {
    return versionId === this.versionId || this.mine.has(versionId)
  }

  /** Resolves once any upload in flight has finished. */
  idle(): Promise<void> {
    return this.pumping ?? Promise.resolve()
  }

  dispose(): void {
    this.halted = true
    if (this.timer) clearTimeout(this.timer)
  }

  private status(s: SyncStatus) {
    this.o.onStatus(s)
  }

  private pump(): Promise<void> {
    this.pumping ??= this.drain().finally(() => (this.pumping = null))
    return this.pumping
  }

  private async drain(): Promise<void> {
    for (;;) {
      if (this.halted) return
      const pending = await this.o.queue.get(this.o.slotId)
      if (!pending) return this.status({ state: 'synced', flagged: this.flagged })
      this.status({ state: 'syncing' })

      let res: Response
      try {
        res = await (this.o.fetch ?? fetch)(`/api/slots/${this.o.slotId}/saves`, {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream', 'x-parent-version': this.versionId },
          body: pending.bytes,
        })
      } catch {
        return this.retryLater()
      }

      if (res.ok) {
        const body: { versionId: string; flagged?: number } = await res.json()
        this.versionId = body.versionId
        this.mine.add(body.versionId)
        this.flagged = !!body.flagged
        this.attempts = 0
        await this.o.queue.delete(this.o.slotId, pending.sha256)
        // A newer save may have arrived meanwhile; it is now built on this version.
        await this.o.queue.rebase(this.o.slotId, this.versionId)
        continue
      }
      if (res.status === 409) return this.halt('conflict')
      if (res.status === 423) return this.halt('locked')
      if (res.status === 401 || res.status === 429 || res.status >= 500) return this.retryLater()

      // Anything else (wrong game, unreadable save) will never succeed: drop it.
      const body: { message?: string } = await res.json().catch(() => ({}))
      await this.o.queue.delete(this.o.slotId, pending.sha256)
      return this.status({ state: 'rejected', message: body.message ?? 'That save was rejected.' })
    }
  }

  private retryLater() {
    const delay = Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** this.attempts++)
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.pump()
    }, delay)
    this.status({ state: 'offline', retryAt: Date.now() + delay })
  }
}

// ---- IndexedDB queue (this browser only). Separate database from remembered game files.

const DB = 'pokehub-sync'
const STORE = 'pending-saves'

let db: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  db ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'slotId' })
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  return db
}

/** Read-modify-write the slot's entry inside one transaction, so a concurrent put can't be lost. */
async function update(slotId: string, fn: (current: PendingSave | undefined, store: IDBObjectStore) => void): Promise<void> {
  const tx = (await open()).transaction(STORE, 'readwrite')
  const store = tx.objectStore(STORE)
  const req = store.get(slotId)
  req.onsuccess = () => fn(req.result, store)
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export const indexedDbQueue: SaveQueue = {
  async get(slotId) {
    const tx = (await open()).transaction(STORE, 'readonly')
    const req = tx.objectStore(STORE).get(slotId)
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve((req.result as PendingSave | undefined) ?? null)
      req.onerror = () => reject(req.error)
    })
  },
  put: (save) => update(save.slotId, (_, store) => store.put(save)),
  delete: (slotId, sha256) =>
    update(slotId, (current, store) => {
      if (current && (sha256 === undefined || current.sha256 === sha256)) store.delete(slotId)
    }),
  rebase: (slotId, parent) =>
    update(slotId, (current, store) => {
      if (current) store.put({ ...current, parent })
    }),
}
