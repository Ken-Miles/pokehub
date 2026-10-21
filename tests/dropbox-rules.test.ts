import {
  DROP_MAX_BYTES,
  DROP_NOTE_MAX,
  attachmentHeader,
  cleanFileName,
  cleanNote,
  dropProblem,
  dropSummary,
} from '@/lib/dropbox-rules'
import { MAX_SAVE_BYTES } from '@/lib/games'
import { crc16, hasGbaRomHeader, hasNdsRomHeader } from '@/lib/rom-header'

/** FR-32 / ADR-015: what the tester drop box accepts. Same rules in the browser and on the server. */

function filler(size: number, seed = 1): Uint8Array {
  const b = new Uint8Array(size)
  for (let i = 0; i < b.length; i++) b[i] = (i * 31 + seed * 7 + (i >> 8)) & 0xff
  return b
}

/** First 512 KB of a synthetic DS game file: a valid header, no game data. */
function syntheticNds(): Uint8Array {
  const b = filler(0x80000, 3)
  b.set(Array.from('POKEMON PL\0\0CPUE', (c) => c.charCodeAt(0)), 0)
  b[0x15c] = 0x56
  b[0x15d] = 0xcf
  const crc = crc16(b.subarray(0, 0x15e))
  b[0x15e] = crc & 0xff
  b[0x15f] = crc >> 8
  return b
}

/** First 128 KB of a synthetic GBA game file (same header as tests/nfr01-no-game-files.test.ts). */
function syntheticGba(): Uint8Array {
  const b = filler(0x20000, 2)
  b.set([0x2e, 0x00, 0x00, 0xea], 0)
  b.fill(0, 0xa0, 0xbd)
  b[0xb2] = 0x96
  let chk = 0
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - b[i]) & 0xff
  b[0xbd] = (chk - 0x19) & 0xff
  return b
}

describe('dropProblem', () => {
  it('accepts any save-sized file, including odd sizes from other emulators', () => {
    expect(dropProblem(filler(0x20000))).toBeNull()
    expect(dropProblem(filler(0x20000 + 16))).toBeNull()
    expect(dropProblem(filler(0x8000))).toBeNull() // 32 KB SRAM dump
    expect(dropProblem(filler(DROP_MAX_BYTES))).toBeNull()
  })

  it('caps size at the largest save of any platform', () => {
    expect(DROP_MAX_BYTES).toBe(MAX_SAVE_BYTES)
    expect(dropProblem(filler(DROP_MAX_BYTES + 1))?.code).toBe('bad_size')
    expect(dropProblem(new Uint8Array(0))?.code).toBe('empty')
  })

  it('refuses GBA and DS game files that fit under the cap (NFR-01)', () => {
    expect(hasGbaRomHeader(syntheticGba())).toBe(true)
    expect(hasNdsRomHeader(syntheticNds())).toBe(true)
    expect(dropProblem(syntheticGba())?.code).toBe('game_file')
    expect(dropProblem(syntheticNds())?.code).toBe('game_file')
  })

  it('does not mistake save data for a DS header', () => {
    for (let seed = 0; seed < 200; seed++) expect(hasNdsRomHeader(filler(0x80000, seed))).toBe(false)
    const almost = syntheticNds()
    almost[0x15e] ^= 1 // header CRC off by one bit
    expect(hasNdsRomHeader(almost)).toBe(false)
  })
})

describe('crc16', () => {
  it('is CRC-16/MODBUS', () => {
    expect(crc16(new TextEncoder().encode('123456789'))).toBe(0x4b37)
  })
})

describe('cleanFileName', () => {
  it('keeps the last path segment, strips control characters and quotes', () => {
    expect(cleanFileName('C:\\saves\\Emerald.sav')).toBe('Emerald.sav')
    expect(cleanFileName('../../etc/passwd')).toBe('passwd')
    expect(cleanFileName('a"b\u0000\nc.sav')).toBe('abc.sav')
    expect(cleanFileName('')).toBe('save.sav')
    expect(cleanFileName('ポケモン.sav')).toBe('ポケモン.sav')
    expect(cleanFileName('x'.repeat(300) + '.sav')).toHaveLength(120)
    expect(cleanFileName('x'.repeat(300) + '.sav').endsWith('.sav')).toBe(true)
  })
})

describe('cleanNote', () => {
  it('trims, turns empty into null and refuses long notes', () => {
    expect(cleanNote('  crashes after gym 3 ')).toBe('crashes after gym 3')
    expect(cleanNote('   ')).toBeNull()
    expect(cleanNote(null)).toBeNull()
    expect(cleanNote('x'.repeat(DROP_NOTE_MAX + 1))).toMatchObject({ code: 'note_too_long' })
  })
})

describe('attachmentHeader', () => {
  it('gives an ASCII fallback and the exact UTF-8 name', () => {
    expect(attachmentHeader('Emerald.sav')).toBe(`attachment; filename="Emerald.sav"; filename*=UTF-8''Emerald.sav`)
    expect(attachmentHeader('ポケ.sav')).toBe(`attachment; filename="__.sav"; filename*=UTF-8''%E3%83%9D%E3%82%B1.sav`)
  })
})

describe('dropSummary', () => {
  const base = { readable: true, parseError: null, generation: 3, gameVersion: 'E', trainerName: 'MAY', trainerId: 123 }
  it('describes readable and unreadable files', () => {
    expect(dropSummary(base)).toBe('Gen 3 · E · MAY · ID 00123')
    expect(dropSummary({ ...base, readable: false, parseError: 'unrecognised' })).toMatch(/Unreadable.*unrecognised/)
  })
})
