import hashes from '@/data/rom-hashes.json'
import { EXCLUDED_DUMP, parseDat } from '@/lib/nointro'

const SAMPLE = `<?xml version="1.0"?>
<datafile>
  <header><name>Nintendo - Game Boy Advance</name><version>20261020-043346</version></header>
  <game name="Pokemon - Emerald Version (USA, Europe)">
    <rom name="Pokemon - Emerald Version (USA, Europe).gba" size="16777216" crc="1F1C08FB" sha1="F3AE088181BF583E55DAF962A92BB46F4F1D07B7" serial="BPEE"/>
  </game>
  <game name="Pokemon - Leaf Green (USA) (Pirate)">
    <rom name="x.gba" size="33554432" crc="11870bd9" sha1="b5c0c40ac5dc25bef289973080366d29359bb81b"/>
  </game>
  <game name="Tom &amp; Jerry">
    <rom name="t.gba" size="1" sha1="aa" serial="AAAE"/>
  </game>
</datafile>`

describe('parseDat', () => {
  const dat = parseDat(SAMPLE)
  it('reads the header', () => {
    expect(dat).toMatchObject({ name: 'Nintendo - Game Boy Advance', version: '20261020-043346' })
  })
  it('reads roms with lower-cased hashes and serials', () => {
    expect(dat.roms[0]).toEqual({
      game: 'Pokemon - Emerald Version (USA, Europe)',
      name: 'Pokemon - Emerald Version (USA, Europe).gba',
      size: 16777216,
      sha1: 'f3ae088181bf583e55daf962a92bb46f4f1d07b7',
      crc: '1f1c08fb',
      serial: 'BPEE',
    })
  })
  it('decodes basic entities', () => {
    expect(dat.roms[2].game).toBe('Tom & Jerry')
  })
})

describe('EXCLUDED_DUMP', () => {
  it('drops bootlegs, kiosk, debug and Switch re-releases', () => {
    expect(EXCLUDED_DUMP.test('Pokemon - Leaf Green (USA) (Pirate)')).toBe(true)
    expect(EXCLUDED_DUMP.test('Pokemon - FireRed Version (USA, Europe) (Rev 10) (Switch)')).toBe(true)
    expect(EXCLUDED_DUMP.test('Pokemon - Rubin-Edition (Germany) (Debug Version)')).toBe(true)
    expect(EXCLUDED_DUMP.test('Pokemon - FireRed Version (USA, Europe) (Rev 1)')).toBe(false)
  })
})

describe('data/rom-hashes.json', () => {
  const table = (hashes as { hashes: Record<string, string[]> }).hashes
  it('covers every US game and its revisions', () => {
    expect(table.BPEE).toContain('f3ae088181bf583e55daf962a92bb46f4f1d07b7') // Emerald
    expect(table.AXVE).toHaveLength(3) // Ruby 1.0, 1.1, 1.2
    expect(table.AXPE).toHaveLength(3) // Sapphire 1.0, 1.1, 1.2
    expect(table.BPRE).toHaveLength(2) // FireRed 1.0, 1.1 (Switch build excluded)
    expect(table.BPGE).toHaveLength(2) // LeafGreen 1.0, 1.1
  })
})
