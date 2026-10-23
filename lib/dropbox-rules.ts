import { MAX_SAVE_BYTES } from '@/lib/games'
import { hasGbRomHeader, hasGbaRomHeader, hasNdsRomHeader } from '@/lib/rom-header'
import type { Rejection } from '@/lib/save-rules'

/**
 * FR-32 tester drop box: pure rules, shared by the upload page and the API so
 * the browser refuses exactly what the server would (tests/dropbox-rules.test.ts).
 * Drop-box files are not save versions (ADR-015): any save-sized file is kept,
 * even one the save service can't read, but never a game file (NFR-01).
 */

/** Largest save of any platform: nothing bigger is read, let alone stored. */
export const DROP_MAX_BYTES = MAX_SAVE_BYTES
export const DROP_NOTE_MAX = 500
export const DROP_NAME_MAX = 120
/** NFR-05: uploads per tester per day. */
export const DROP_DAILY_LIMIT = 100

export function dropProblem(bytes: Uint8Array): Rejection | null {
  if (bytes.length === 0) return { status: 400, code: 'empty', message: 'That file is empty.' }
  if (bytes.length > DROP_MAX_BYTES) return tooBig()
  if (hasGbaRomHeader(bytes) || hasGbRomHeader(bytes) || hasNdsRomHeader(bytes))
    return { status: 400, code: 'game_file', message: 'That is a game file, not a save. Game files are never uploaded.' }
  return null
}

export function tooBig(): Rejection {
  return {
    status: 413,
    code: 'bad_size',
    message: `That is too big to be a save file (the largest is ${Math.round(DROP_MAX_BYTES / 1024)} KB).`,
  }
}

/** Last path segment, printable characters only, at most DROP_NAME_MAX long. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? ''
  const clean = base.replace(/[\u0000-\u001f\u007f"]/g, '').trim().slice(-DROP_NAME_MAX)
  return clean || 'save.sav'
}

/** Optional tester note: trimmed, empty → null, too long → refused. */
export function cleanNote(note: string | null | undefined): string | null | Rejection {
  const n = (note ?? '').trim()
  if (!n) return null
  if (n.length > DROP_NOTE_MAX)
    return { status: 400, code: 'note_too_long', message: `Keep the note under ${DROP_NOTE_MAX} characters.` }
  return n
}

/** Content-Disposition for a download: ASCII fallback plus the exact UTF-8 name. */
export function attachmentHeader(fileName: string): string {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/[\\"]/g, '_')
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`
}

export function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} bytes` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`
}

/** One line on what the save service saw in a drop-box file, for the lists. */
export function dropSummary(f: {
  readable: boolean
  parseError: string | null
  generation: number | null
  gameVersion: string | null
  trainerName: string | null
  trainerId: number | null
}): string {
  if (!f.readable) return `Unreadable by the save service (${f.parseError ?? 'unknown'})`
  const trainer = f.trainerName ? ` · ${f.trainerName}${f.trainerId !== null ? ` · ID ${String(f.trainerId).padStart(5, '0')}` : ''}` : ''
  return `Gen ${f.generation} · ${f.gameVersion}${trainer}`
}
