import {
  MAX_SAVE_BYTES,
  identifyGame,
  isAcceptedSaveSize,
  maxSaveBytes,
  readGbaHeader,
  readNdsHeader,
  readRomHeader,
  saveFamilyMatchesGame,
} from '@/lib/games'
import { fakeGbHeader } from './helpers/client-sync'

function fakeHeader(code: string, title = 'POKEMON EMER'): Uint8Array {
  const b = new Uint8Array(0x200)
  b.set(Array.from(title, (c) => c.charCodeAt(0)), 0xa0)
  b.set(Array.from(code, (c) => c.charCodeAt(0)), 0xac)
  b[0xb2] = 0x96
  return b
}

describe('readGbaHeader', () => {
  it('reads title and code', () => {
    expect(readGbaHeader(fakeHeader('BPEE'))).toEqual({ platform: 'GBA', title: 'POKEMON EMER', code: 'BPEE' })
  })
  it('rejects files without the fixed header byte', () => {
    const b = fakeHeader('BPEE')
    b[0xb2] = 0
    expect(readGbaHeader(b)).toBeNull()
  })
  it('rejects files too small to be a ROM', () => {
    expect(readGbaHeader(new Uint8Array(16))).toBeNull()
  })
})

describe('readGbHeader (ADR-019)', () => {
  it('guesses the Gen 1 code from the title and the Japan/overseas byte', () => {
    expect(readRomHeader(fakeGbHeader('POKEMON RED'))).toEqual({ platform: 'GB', title: 'POKEMON RED', code: 'APAO' })
    expect(readRomHeader(fakeGbHeader('POKEMON GREEN', true))?.code).toBe('APGJ')
    expect(readRomHeader(fakeGbHeader('POKEMON YELLOW'))?.code).toBe('APSO')
  })
  it('leaves the code empty for other titles (the SHA-1 decides)', () => {
    expect(readRomHeader(fakeGbHeader('TETRIS'))).toMatchObject({ platform: 'GB', code: '' })
  })
  it('rejects a broken header checksum', () => {
    const b = fakeGbHeader('POKEMON RED')
    b[0x14d] ^= 1
    expect(readRomHeader(b)).toBeNull()
  })
})

describe('identifyGame', () => {
  it('knows Gen 1 on Game Boy, playable, Japanese apart from the rest', () => {
    expect(['APAO', 'APEO', 'APSO', 'APGJ'].map((c) => identifyGame('GB', c)?.name)).toEqual(['Red', 'Blue', 'Yellow', 'Green'])
    expect(identifyGame('GB', 'APAJ')).toMatchObject({ generation: 1, family: 'RBY', playable: true, language: 'J' })
    expect(isAcceptedSaveSize('GB', 0x8000)).toBe(true)
  })
  it('knows all five Gen 3 games', () => {
    expect(['AXVE', 'AXPE', 'BPEE', 'BPRE', 'BPGE'].map((c) => identifyGame('GBA', c)?.name)).toEqual([
      'Ruby',
      'Sapphire',
      'Emerald',
      'FireRed',
      'LeafGreen',
    ])
  })
  it('reads the region from the last letter', () => {
    expect(identifyGame('GBA', 'BPRP')).toMatchObject({ region: 'Europe', language: 'P' })
  })
  it('Gen 1–5 are playable; Gen 6–7 are catalogued as planned', () => {
    expect(identifyGame('GBA', 'BPEE')).toMatchObject({ generation: 3, playable: true })
    expect(identifyGame('NDS', 'ADAE')).toMatchObject({ name: 'Diamond', generation: 4, family: 'DP', playable: true })
    expect(identifyGame('NDS', 'IRBO')).toMatchObject({ name: 'Black', generation: 5, region: 'USA and Europe' })
    expect(identifyGame('N3DS', 'OR')).toMatchObject({ name: 'Omega Ruby', generation: 6, family: 'ORAS', region: null })
    expect(identifyGame('N3DS', 'UM')).toMatchObject({ generation: 7, family: 'USUM', playable: false })
  })
  it('keeps platforms apart: AXVE is Ruby on GBA, not a DS Pokémon game', () => {
    expect(identifyGame('GBA', 'AXVE')?.name).toBe('Ruby')
    expect(identifyGame('NDS', 'AXVE')).toBeNull()
    expect(identifyGame('GBA', 'ADAE')).toBeNull()
  })
  it('rejects unknown games and regions', () => {
    expect(identifyGame('GBA', 'BPEX')).toBeNull()
    expect(identifyGame('N3DS', 'ZZ')).toBeNull()
  })
})

describe('saveFamilyMatchesGame', () => {
  it('matches Ruby and Sapphire to the shared RS save format', () => {
    expect(saveFamilyMatchesGame('RS', 'GBA', 'AXVE')).toBe(true)
    expect(saveFamilyMatchesGame('RS', 'GBA', 'AXPE')).toBe(true)
    expect(saveFamilyMatchesGame('E', 'GBA', 'AXVE')).toBe(false)
    expect(saveFamilyMatchesGame('FRLG', 'GBA', 'BPGE')).toBe(true)
  })
  it('works for later generations', () => {
    expect(saveFamilyMatchesGame('HGSS', 'NDS', 'IPKE')).toBe(true)
    expect(saveFamilyMatchesGame('BW', 'NDS', 'IREO')).toBe(false) // Black 2 is B2W2
    expect(saveFamilyMatchesGame('XY', 'N3DS', 'Y')).toBe(true)
  })
})

function fakeNdsHeader(code: string, title = 'POKEMON D'): Uint8Array {
  const b = new Uint8Array(0x200)
  b.set(Array.from(title, (c) => c.charCodeAt(0)), 0x00)
  b.set(Array.from(code, (c) => c.charCodeAt(0)), 0x0c)
  b[0x15c] = 0x56
  b[0x15d] = 0xcf
  return b
}

describe('readNdsHeader / readRomHeader', () => {
  it('reads a DS header', () => {
    expect(readNdsHeader(fakeNdsHeader('ADAE'))).toEqual({ platform: 'NDS', title: 'POKEMON D', code: 'ADAE' })
  })
  it('needs the Nintendo logo CRC', () => {
    const b = fakeNdsHeader('ADAE')
    b[0x15c] = 0
    expect(readNdsHeader(b)).toBeNull()
  })
  it('tells GBA and DS files apart', () => {
    expect(readRomHeader(fakeHeader('BPEE'))?.platform).toBe('GBA')
    expect(readRomHeader(fakeNdsHeader('IPKE'))?.platform).toBe('NDS')
    expect(readRomHeader(new Uint8Array(0x200))).toBeNull()
  })
})

describe('save sizes', () => {
  it("accepts each platform's own sizes only", () => {
    expect(isAcceptedSaveSize('GBA', 131_072)).toBe(true)
    expect(isAcceptedSaveSize('GBA', 524_288)).toBe(false)
    expect(isAcceptedSaveSize('NDS', 524_288)).toBe(true)
    expect(isAcceptedSaveSize('N3DS', 0x76000)).toBe(true) // Omega Ruby / Alpha Sapphire
  })
  it('keeps every limit far below a game file', () => {
    expect(maxSaveBytes('GBA')).toBe(131_088)
    expect(MAX_SAVE_BYTES).toBeLessThan(1024 * 1024)
  })
})
