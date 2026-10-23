import { inspectRom } from '@/lib/client/rom'
import { SaveSync, hasGbaRomHeader, romCheck, saveProblem } from '@/lib/client/save-sync'
import { dropProblem } from '@/lib/dropbox-rules'
import { MAX_SAVE_BYTES } from '@/lib/games'
import { fakeFetch, fakeGbHeader, fakeSave, memoryQueue, statuses, type Recorded } from './helpers/client-sync'

/**
 * NFR-01 / FR-04: no request ever carries game-file bytes. Drives the browser's
 * real request builders and save sync with a synthetic 16 MB "game file" (a
 * valid GBA header + filler — no real game data) and checks every payload.
 */
function syntheticRom(): ArrayBuffer {
  const b = new Uint8Array(16 * 1024 * 1024)
  for (let i = 0; i < b.length; i++) b[i] = (i * 13 + (i >> 9)) & 0xff
  b.set([0x2e, 0x00, 0x00, 0xea], 0) // branch over the header
  b.set(Array.from('POKEMON EMER', (c) => c.charCodeAt(0)), 0xa0)
  b.set(Array.from('BPEE', (c) => c.charCodeAt(0)), 0xac)
  b.fill(0, 0xb0, 0xbd)
  b[0xb2] = 0x96
  let chk = 0
  for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - b[i]) & 0xff
  b[0xbd] = (chk - 0x19) & 0xff
  return b.buffer
}

const ROM = syntheticRom()

/** 64 bytes from the middle of the game file; no upload may contain them. */
function containsRomBytes(body: ArrayBuffer): boolean {
  const hay = new Uint8Array(body)
  const needle = new Uint8Array(ROM, 8 * 1024 * 1024, 64)
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer
    return true
  }
  return false
}

function assertNoGameFileBytes(requests: Recorded[]) {
  for (const r of requests) {
    if (typeof r.body === 'string') {
      expect(r.body.length).toBeLessThan(512)
    } else if (r.body) {
      expect(r.body.byteLength).toBeLessThanOrEqual(MAX_SAVE_BYTES)
      expect(hasGbaRomHeader(new Uint8Array(r.body))).toBe(false)
      expect(containsRomBytes(r.body)).toBe(false)
    }
  }
}

describe('NFR-01: no game-file bytes in any request', () => {
  it('identifying the game sends only platform, code and SHA-1', async () => {
    const inspected = await inspectRom(new Blob([ROM]))
    const body = JSON.stringify({ ...romCheck(inspected), origin: 'NEW' })
    expect(JSON.parse(body)).toEqual({ platform: 'GBA', code: 'BPEE', sha1: expect.stringMatching(/^[0-9a-f]{40}$/), origin: 'NEW' })
    assertNoGameFileBytes([{ url: '/api/slots', method: 'POST', headers: {}, body }])
  })

  it('save sync refuses a whole game file and a save-sized slice of one, before any request', async () => {
    const net = fakeFetch()
    const st = statuses()
    const sync = new SaveSync({ slotId: 's1', platform: 'GBA', queue: memoryQueue(), fetch: net.fetch, onStatus: st.onStatus })
    await sync.boot('v0', null)

    await sync.submit(ROM.slice(0))
    expect(st.last()).toMatchObject({ state: 'rejected' })
    await sync.submit(ROM.slice(0, 0x20000)) // save-sized, but starts with the game header
    expect(st.last()).toMatchObject({ state: 'rejected', message: expect.stringMatching(/game file/) })
    expect(net.requests).toHaveLength(0)

    await sync.submit(fakeSave(1)) // a real save still goes through
    expect(net.requests).toHaveLength(1)
    assertNoGameFileBytes(net.requests)
  })

  it('import refuses a game file picked as the save', () => {
    expect(saveProblem('GBA', ROM)).toMatch(/isn't a Game Boy Advance save/)
    expect(saveProblem('GBA', ROM.slice(0, 0x20000))).toMatch(/game file/)
    expect(saveProblem('GBA', fakeSave(1))).toBeNull()
    expect(saveProblem('GBA', fakeSave(1, 0x20000 + 16))).toBeNull() // RTC footer
  })

  it('a 32 KB Game Boy game is refused as a Game Boy save; a 32 KB save is not', () => {
    const gb = fakeGbHeader('TETRIS').buffer as ArrayBuffer
    expect(saveProblem('GB', gb)).toMatch(/game file/)
    expect(saveProblem('GB', fakeSave(1, 0x8000))).toBeNull()
    expect(dropProblem(new Uint8Array(gb))).toMatchObject({ code: 'game_file' })
  })

  it('the save fixtures used elsewhere are not mistaken for game files', async () => {
    const { readFileSync } = await import('fs')
    for (const f of ['synthetic-emerald-lv5.sav', 'synthetic-emerald-lv6.sav']) {
      const b = readFileSync(`tests/fixtures/${f}`)
      expect(saveProblem('GBA', b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength))).toBeNull()
    }
  })
})
