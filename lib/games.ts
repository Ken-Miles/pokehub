/**
 * Supported games and GBA header parsing (FR-05). Runs in the browser and on the
 * server: the browser reads the header + hashes the file, the server only ever
 * sees the 4-letter code and the SHA-1.
 */

export type SaveFamily = 'RS' | 'E' | 'FRLG'

export interface GameInfo {
  code: string // full 4-letter code, e.g. BPEE
  name: string
  generation: 3
  family: SaveFamily
  region: string
  language: string // last letter of the code
}

// First three letters of the header code → game. The fourth letter is the region.
const GEN3: Record<string, { name: string; family: SaveFamily }> = {
  AXV: { name: 'Ruby', family: 'RS' },
  AXP: { name: 'Sapphire', family: 'RS' },
  BPE: { name: 'Emerald', family: 'E' },
  BPR: { name: 'FireRed', family: 'FRLG' },
  BPG: { name: 'LeafGreen', family: 'FRLG' },
}

export const REGIONS: Record<string, string> = {
  E: 'USA',
  P: 'Europe',
  J: 'Japan',
  D: 'Germany',
  F: 'France',
  I: 'Italy',
  S: 'Spain',
}

const GBA_HEADER_SIZE = 0xc0
const GBA_FIXED_BYTE_OFFSET = 0xb2 // always 0x96 in a real GBA header
const GBA_FIXED_BYTE = 0x96

export interface GbaHeader {
  title: string
  code: string
}

/** Read title + game code from a GBA ROM header, or null if it isn't one. */
export function readGbaHeader(bytes: Uint8Array): GbaHeader | null {
  if (bytes.length < GBA_HEADER_SIZE) return null
  if (bytes[GBA_FIXED_BYTE_OFFSET] !== GBA_FIXED_BYTE) return null
  const ascii = (from: number, to: number) =>
    String.fromCharCode(...bytes.subarray(from, to)).replace(/\0+$/, '')
  const code = ascii(0xac, 0xb0)
  if (!/^[A-Z0-9]{4}$/.test(code)) return null
  return { title: ascii(0xa0, 0xac), code }
}

/** Map a header code to a supported game, or null if unsupported. */
export function identifyGame(code: string): GameInfo | null {
  const game = GEN3[code.slice(0, 3)]
  const language = code.slice(3)
  if (!game || !REGIONS[language]) return null
  return { code, ...game, generation: 3, region: REGIONS[language], language }
}

/** Does the save family the save service reports match the slot's game? */
export function saveFamilyMatchesGame(family: string, gameCode: string): boolean {
  return identifyGame(gameCode)?.family === family
}
