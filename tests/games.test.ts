import { identifyGame, readGbaHeader, saveFamilyMatchesGame } from '@/lib/games'

function fakeHeader(code: string, title = 'POKEMON EMER'): Uint8Array {
  const b = new Uint8Array(0x200)
  b.set(Array.from(title, (c) => c.charCodeAt(0)), 0xa0)
  b.set(Array.from(code, (c) => c.charCodeAt(0)), 0xac)
  b[0xb2] = 0x96
  return b
}

describe('readGbaHeader', () => {
  it('reads title and code', () => {
    expect(readGbaHeader(fakeHeader('BPEE'))).toEqual({ title: 'POKEMON EMER', code: 'BPEE' })
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

describe('identifyGame', () => {
  it('knows all five Gen 3 games', () => {
    expect(['AXVE', 'AXPE', 'BPEE', 'BPRE', 'BPGE'].map((c) => identifyGame(c)?.name)).toEqual([
      'Ruby',
      'Sapphire',
      'Emerald',
      'FireRed',
      'LeafGreen',
    ])
  })
  it('reads the region from the last letter', () => {
    expect(identifyGame('BPRP')).toMatchObject({ region: 'Europe', language: 'P' })
  })
  it('rejects unsupported games and unknown regions', () => {
    expect(identifyGame('ADAE')).toBeNull() // Diamond: later phase
    expect(identifyGame('BPEX')).toBeNull()
  })
})

describe('saveFamilyMatchesGame', () => {
  it('matches Ruby and Sapphire to the shared RS save format', () => {
    expect(saveFamilyMatchesGame('RS', 'AXVE')).toBe(true)
    expect(saveFamilyMatchesGame('RS', 'AXPE')).toBe(true)
    expect(saveFamilyMatchesGame('E', 'AXVE')).toBe(false)
    expect(saveFamilyMatchesGame('FRLG', 'BPGE')).toBe(true)
  })
})
