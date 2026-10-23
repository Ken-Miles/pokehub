'use client'

import hashes from '@/data/rom-hashes.json'
import { PLATFORMS, identifyGame, readRomHeader, type GameInfo, type Platform } from '@/lib/games'

// Gen 1 headers carry no game code, so the dump itself says which game it is.
const gbCodes = new Map(
  Object.entries((hashes as { hashes: { GB?: Record<string, string[]> } }).hashes.GB ?? {}).flatMap(([code, sha1s]) =>
    sha1s.map((sha1) => [sha1, code] as const),
  ),
)

export interface InspectedRom {
  bytes: ArrayBuffer
  platform: Platform
  code: string
  sha1: string
  game: GameInfo
}

async function sha1Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-1', bytes)
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** FR-05: read the header and hash locally. Only `code` and `sha1` are ever sent. */
export async function inspectRom(file: Blob): Promise<InspectedRom> {
  const bytes = await file.arrayBuffer()
  const header = readRomHeader(new Uint8Array(bytes))
  if (!header) throw new Error("That file isn't a Game Boy, Game Boy Advance or DS game.")
  const sha1 = await sha1Hex(bytes)
  const code = (header.platform === 'GB' && gbCodes.get(sha1)) || header.code
  const game = identifyGame(header.platform, code)
  if (!game) throw new Error(`"${header.title}"${code ? ` (${code})` : ''} isn't a supported Pokémon game.`)
  if (!game.playable) {
    const info = PLATFORMS[header.platform]
    throw new Error(`Pokémon ${game.name} is a ${info.name} game. Those are planned for ${info.phase}.`)
  }
  return { bytes, platform: header.platform, code, sha1, game }
}

// ---- optional "remember this game on this device" (FR-04). IndexedDB, this browser only.

const DB = 'pokehub'
const STORE = 'roms'

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1)
    req.onupgradeneeded = () => req.result.createObjectStore(STORE)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const req = fn(db.transaction(STORE, mode).objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function rememberRom(code: string, bytes: ArrayBuffer): Promise<void> {
  await run('readwrite', (s) => s.put(bytes, code))
}

export async function rememberedRom(code: string): Promise<ArrayBuffer | null> {
  try {
    return (await run<ArrayBuffer | undefined>('readonly', (s) => s.get(code))) ?? null
  } catch {
    return null
  }
}

export async function forgetRom(code: string): Promise<void> {
  await run('readwrite', (s) => s.delete(code))
}
