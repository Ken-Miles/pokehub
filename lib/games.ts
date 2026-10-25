/**
 * Game catalog (FR-05, ADR-013, ADR-019). Every supported game for Gen 1–7
 * lives here as data; a platform is switched on by its `availability`,
 * not by new code paths. Runs in the browser and on the server: the browser reads
 * the header + hashes the file, the server only ever sees the platform, the
 * 4-letter code and the SHA-1.
 */

import { hasGbRomHeader } from '@/lib/rom-header'

export type Platform = 'GB' | 'GBA' | 'NDS' | 'N3DS'
export type Generation = 1 | 2 | 3 | 4 | 5 | 6 | 7

/** Save format as the save service (PKHeX) reports it. Games sharing a format share a family. */
export type SaveFamily = 'RBY' | 'GS' | 'C' | 'RS' | 'E' | 'FRLG' | 'DP' | 'Pt' | 'HGSS' | 'BW' | 'B2W2' | 'XY' | 'ORAS' | 'SM' | 'USUM'

export interface PlatformInfo {
  name: string
  /** playable = on the site now; planned = in the catalog, refused with "coming later". */
  availability: 'playable' | 'planned'
  /** browser = our emulator in the iframe; companion = desktop emulator + companion app (Phase 6). */
  runsIn: 'browser' | 'companion'
  /** rom-header = game picked from the player's game file; save = read from the save itself. */
  identifiedBy: 'rom-header' | 'save'
  romExtension: string | null
  /** Core the emulator iframe boots; null when the game doesn't run on the site. */
  emulatorCore: 'gb' | 'gba' | 'nds' | null
  /** Exact sizes accepted for upload; the largest is enforced before buffering (NFR-01). */
  saveSizes: readonly number[]
  phase: string
}

const DESMUME_FOOTER = 122

export const PLATFORMS: Record<Platform, PlatformInfo> = {
  GB: {
    name: 'Game Boy',
    availability: 'playable',
    runsIn: 'browser',
    identifiedBy: 'rom-header',
    romExtension: '.gb,.gbc', // Gen 2 carts are Game Boy Color (.gbc); the same core runs both
    emulatorCore: 'gb',
    // 32 KB SRAM; Gen 2 carts' clock block appended by emulators: 16, 44 or 48 bytes (our mGBA build: 48).
    saveSizes: [0x8000, 0x8010, 0x802c, 0x8030],
    phase: 'Phase 1',
  },
  GBA: {
    name: 'Game Boy Advance',
    availability: 'playable',
    runsIn: 'browser',
    identifiedBy: 'rom-header',
    romExtension: '.gba',
    emulatorCore: 'gba',
    saveSizes: [0x20000, 0x20000 + 16], // 128 KB flash; some emulators append a 16-byte RTC footer
    phase: 'Phase 1',
  },
  NDS: {
    name: 'Nintendo DS',
    availability: 'playable',
    runsIn: 'browser',
    identifiedBy: 'rom-header',
    romExtension: '.nds',
    emulatorCore: 'nds',
    saveSizes: [0x80000, 0x80000 + DESMUME_FOOTER], // 512 KB raw (melonDS), or a DeSmuME .dsv (stored raw)
    phase: 'Phase 4',
  },
  N3DS: {
    name: 'Nintendo 3DS',
    availability: 'planned',
    runsIn: 'companion',
    identifiedBy: 'save',
    romExtension: null,
    emulatorCore: null,
    saveSizes: [0x65600, 0x76000, 0x6be00, 0x6cc00], // X/Y, OR/AS, S/M, US/UM
    phase: 'Phase 6',
  },
}

interface CatalogEntry {
  name: string
  generation: Generation
  family: SaveFamily
}

/**
 * GBA and DS games by the first three letters of the header code (the fourth is
 * the region). Keyed per platform: DS codes reuse GBA ones (AXVE is Ruby on GBA
 * and Disney Friends on DS). 3DS games are keyed by the version the save reports.
 */
const CATALOG: Record<Platform, Record<string, CatalogEntry>> = {
  // Game Boy codes are No-Intro's serials (APA is Red, AAU Gold). The last letter is
  // only J (Japan), K (Korea) or O (every other language): the one split that matters
  // for the link cable. Gen 1 carts carry no code in their header at all. The browser finds the code by
  // SHA-1 (lib/client/rom.ts), falling back to the header title for unlisted dumps.
  GB: {
    APA: { name: 'Red', generation: 1, family: 'RBY' },
    APG: { name: 'Green', generation: 1, family: 'RBY' },
    APE: { name: 'Blue', generation: 1, family: 'RBY' },
    APS: { name: 'Yellow', generation: 1, family: 'RBY' },
    AAU: { name: 'Gold', generation: 2, family: 'GS' },
    AAX: { name: 'Silver', generation: 2, family: 'GS' },
    BYT: { name: 'Crystal', generation: 2, family: 'C' },
  },
  GBA: {
    AXV: { name: 'Ruby', generation: 3, family: 'RS' },
    AXP: { name: 'Sapphire', generation: 3, family: 'RS' },
    BPE: { name: 'Emerald', generation: 3, family: 'E' },
    BPR: { name: 'FireRed', generation: 3, family: 'FRLG' },
    BPG: { name: 'LeafGreen', generation: 3, family: 'FRLG' },
  },
  NDS: {
    ADA: { name: 'Diamond', generation: 4, family: 'DP' },
    APA: { name: 'Pearl', generation: 4, family: 'DP' },
    CPU: { name: 'Platinum', generation: 4, family: 'Pt' },
    IPK: { name: 'HeartGold', generation: 4, family: 'HGSS' },
    IPG: { name: 'SoulSilver', generation: 4, family: 'HGSS' },
    IRB: { name: 'Black', generation: 5, family: 'BW' },
    IRA: { name: 'White', generation: 5, family: 'BW' },
    IRE: { name: 'Black 2', generation: 5, family: 'B2W2' },
    IRD: { name: 'White 2', generation: 5, family: 'B2W2' },
  },
  N3DS: {
    X: { name: 'X', generation: 6, family: 'XY' },
    Y: { name: 'Y', generation: 6, family: 'XY' },
    OR: { name: 'Omega Ruby', generation: 6, family: 'ORAS' },
    AS: { name: 'Alpha Sapphire', generation: 6, family: 'ORAS' },
    SN: { name: 'Sun', generation: 7, family: 'SM' },
    MN: { name: 'Moon', generation: 7, family: 'SM' },
    US: { name: 'Ultra Sun', generation: 7, family: 'USUM' },
    UM: { name: 'Ultra Moon', generation: 7, family: 'USUM' },
  },
}

export const REGIONS: Record<string, string> = {
  E: 'USA',
  P: 'Europe',
  O: 'USA and Europe', // Gen 5 shipped one international build
  J: 'Japan',
  K: 'Korea',
  D: 'Germany',
  F: 'France',
  I: 'Italy',
  S: 'Spain',
}

export interface GameInfo extends CatalogEntry {
  platform: Platform
  code: string // GBA/DS: full header code (BPEE). 3DS: version code (OR)
  region: string | null // null for 3DS: the save carries the language
  language: string | null
  playable: boolean
}

export const MAX_SAVE_BYTES = Math.max(...Object.values(PLATFORMS).flatMap((p) => p.saveSizes))

/** Map a platform + code to a catalog game (playable or planned), or null if unknown. */
export function identifyGame(platform: Platform, code: string): GameInfo | null {
  const info = PLATFORMS[platform]
  if (!info) return null
  const playable = info.availability === 'playable'
  if (info.identifiedBy === 'save') {
    const entry = CATALOG[platform][code]
    return entry ? { ...entry, platform, code, region: null, language: null, playable } : null
  }
  const entry = CATALOG[platform][code.slice(0, 3)]
  const language = code.slice(3)
  if (!entry || code.length !== 4 || !REGIONS[language]) return null
  return { ...entry, platform, code, region: REGIONS[language], language, playable }
}

/** Every catalog game on a platform, for listings ("coming later" and supported). */
export function gamesOn(platform: Platform): (CatalogEntry & { prefix: string })[] {
  return Object.entries(CATALOG[platform]).map(([prefix, e]) => ({ prefix, ...e }))
}

/** Does the save family the save service reports match the slot's game? */
export function saveFamilyMatchesGame(family: string, platform: Platform, gameCode: string): boolean {
  return identifyGame(platform, gameCode)?.family === family
}

/**
 * A DeSmuME .dsv is the raw save, then a 122-byte footer: a text line, six u32s
 * (sizes, type) and "|-DESMUME SAVE-|". Returns the raw save, or `bytes` as they are.
 */
export function withoutDesmumeFooter(bytes: Uint8Array): Uint8Array {
  const cookie = '|-DESMUME SAVE-|'
  if (bytes.length <= DESMUME_FOOTER) return bytes
  const tail = new TextDecoder('latin1').decode(bytes.subarray(bytes.length - cookie.length))
  return tail === cookie ? bytes.subarray(0, bytes.length - DESMUME_FOOTER) : bytes
}

export function isAcceptedSaveSize(platform: Platform, size: number): boolean {
  return PLATFORMS[platform]?.saveSizes.includes(size) ?? false
}

export function maxSaveBytes(platform: Platform): number {
  return Math.max(...PLATFORMS[platform].saveSizes)
}

// ---------------------------------------------------------------- ROM headers

export interface RomHeader {
  platform: Platform
  title: string
  code: string
}

const ascii = (bytes: Uint8Array, from: number, to: number) =>
  String.fromCharCode(...bytes.subarray(from, to)).replace(/\0+$/, '')

const GBA_HEADER_SIZE = 0xc0
const GBA_FIXED_BYTE_OFFSET = 0xb2 // always 0x96 in a real GBA header
const GBA_FIXED_BYTE = 0x96

/** Read title + game code from a GBA ROM header, or null if it isn't one. */
export function readGbaHeader(bytes: Uint8Array): RomHeader | null {
  if (bytes.length < GBA_HEADER_SIZE) return null
  if (bytes[GBA_FIXED_BYTE_OFFSET] !== GBA_FIXED_BYTE) return null
  const code = ascii(bytes, 0xac, 0xb0)
  if (!/^[A-Z0-9]{4}$/.test(code)) return null
  return { platform: 'GBA', title: ascii(bytes, 0xa0, 0xac), code }
}

const NDS_HEADER_SIZE = 0x200
const NDS_LOGO_CRC_OFFSET = 0x15c // CRC of the Nintendo logo: always 0xCF56

/** Read title + game code from a DS ROM header, or null if it isn't one. */
export function readNdsHeader(bytes: Uint8Array): RomHeader | null {
  if (bytes.length < NDS_HEADER_SIZE) return null
  if (bytes[NDS_LOGO_CRC_OFFSET] !== 0x56 || bytes[NDS_LOGO_CRC_OFFSET + 1] !== 0xcf) return null
  const code = ascii(bytes, 0x0c, 0x10)
  if (!/^[A-Z0-9]{4}$/.test(code)) return null
  return { platform: 'NDS', title: ascii(bytes, 0x00, 0x0c), code }
}

const GB_TITLES: [RegExp, string][] = [
  [/CRYSTAL/, 'BYT'],
  [/GLD|GOLD/, 'AAU'],
  [/SLV|SILVER/, 'AAX'],
  [/RED/, 'APA'],
  [/GREEN/, 'APG'],
  [/BLUE/, 'APE'],
  [/YELLOW/, 'APS'],
]

/**
 * A Game Boy header (logo + header checksum). Gen 1 headers have no game code,
 * so `code` is a guess from the English title and the Japan/overseas byte, or ''
 * when the title isn't one of those (Korean carts read as overseas); lib/client/rom.ts prefers the SHA-1 match.
 */
export function readGbHeader(bytes: Uint8Array): RomHeader | null {
  if (!hasGbRomHeader(bytes)) return null
  const title = ascii(bytes, 0x134, 0x144)
  const prefix = GB_TITLES.find(([re]) => re.test(title))?.[1]
  return { platform: 'GB', title, code: prefix ? prefix + (bytes[0x14a] === 0 ? 'J' : 'O') : '' }
}

/** Whichever header matches. GBA first: its check sits outside the GB and DS headers. */
export function readRomHeader(bytes: Uint8Array): RomHeader | null {
  return readGbaHeader(bytes) ?? readGbHeader(bytes) ?? readNdsHeader(bytes)
}
