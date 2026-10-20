import hashes from '@/data/rom-hashes.json'
import { env } from '@/lib/env'
import { identifyGame } from '@/lib/games'

const table = (hashes as { hashes: Record<string, string[]> }).hashes

/**
 * FR-05: accept only official, unmodified dumps. The browser sends the header
 * code and SHA-1; the game file itself never leaves the device.
 */
export function checkRom(code: string, sha1: string): { ok: true } | { ok: false; reason: string } {
  if (!identifyGame(code)) return { ok: false, reason: 'unsupported_game' }
  const known = table[code]
  if (known?.length) {
    return known.includes(sha1.toLowerCase()) ? { ok: true } : { ok: false, reason: 'unrecognised_dump' }
  }
  return env().ALLOW_UNLISTED_ROMS ? { ok: true } : { ok: false, reason: 'unrecognised_dump' }
}
