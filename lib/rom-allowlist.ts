import hashes from '@/data/rom-hashes.json'
import { env } from '@/lib/env'
import { PLATFORMS, identifyGame, type GameInfo, type Platform } from '@/lib/games'

const table = (hashes as { hashes: Partial<Record<Platform, Record<string, string[]>>> }).hashes

export type RomVerdict = { ok: true; game: GameInfo } | { ok: false; reason: 'unsupported_game' | 'not_yet_supported' | 'unrecognised_dump' }

/**
 * FR-05: accept only official, unmodified dumps of playable games. The browser
 * sends the platform, header code and SHA-1; the game file never leaves the device.
 */
export function checkRom(platform: Platform, code: string, sha1: string): RomVerdict {
  const game = identifyGame(platform, code)
  if (!game || PLATFORMS[platform].identifiedBy !== 'rom-header') return { ok: false, reason: 'unsupported_game' }
  if (!game.playable) return { ok: false, reason: 'not_yet_supported' }
  const known = table[platform]?.[code]
  if (known?.length) return known.includes(sha1.toLowerCase()) ? { ok: true, game } : { ok: false, reason: 'unrecognised_dump' }
  return env().ALLOW_UNLISTED_ROMS ? { ok: true, game } : { ok: false, reason: 'unrecognised_dump' }
}

export function romRejectionMessage(reason: string, platform: Platform): string {
  const info = PLATFORMS[platform]
  if (reason === 'not_yet_supported') return `${info.name} games are planned for ${info.phase}. Not playable yet.`
  if (reason === 'unsupported_game') return "That game isn't supported. Supported now: Ruby, Sapphire, Emerald, FireRed, LeafGreen."
  return "That doesn't look like an unmodified copy of the game. ROM hacks aren't supported."
}
