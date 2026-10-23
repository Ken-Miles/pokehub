import { createHash } from 'crypto'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Socket } from 'socket.io-client'

/** FR-36 / ADR-023: test bots. */

describe('bot friend codes', () => {
  it('reserves 0000-0000-NNNN for bots and never deals it to a player', async () => {
    vi.resetModules()
    let calls = 0
    // The first code drawn is all zeros (a bot's); the next one is not.
    vi.doMock('crypto', async (orig) => ({ ...(await orig<typeof import('crypto')>()), randomInt: () => (calls++ < 12 ? 0 : 7) }))
    const { newFriendCode, botFriendCode, isBotFriendCode } = await import('@/lib/friend-code')
    expect(newFriendCode()).toBe('7777-7777-7777')
    expect(botFriendCode(5)).toBe('0000-0000-0005')
    expect(botFriendCode(9999)).toBe('0000-0000-9999')
    expect(() => botFriendCode(0)).toThrow()
    expect(() => botFriendCode(10000)).toThrow()
    expect(isBotFriendCode('0000-0000-0016')).toBe(true)
    expect(isBotFriendCode('0000-0001-0016')).toBe(false)
    vi.doUnmock('crypto')
  })
})

describe('botUser: the bot host acting as a bot', () => {
  const SECRET = 'k'.repeat(40)
  const users: Record<string, { username: string; isBot: boolean; status: string }> = {
    bot5: { username: 'bot5', isBot: true, status: 'ACTIVE' },
    alice: { username: 'alice', isBot: false, status: 'ACTIVE' },
    bot6: { username: 'bot6', isBot: true, status: 'BANNED' },
  }
  async function load(secret: string | undefined) {
    vi.resetModules()
    vi.doMock('@/lib/env', () => ({ env: () => ({ BOT_HOST_SECRET: secret }) }))
    vi.doMock('@/lib/db', () => ({ prisma: { user: { findUnique: async ({ where }: { where: { username: string } }) => users[where.username] ?? null } } }))
    return (await import('@/lib/bot-auth')).botUser
  }
  afterEach(() => {
    vi.doUnmock('@/lib/env')
    vi.doUnmock('@/lib/db')
  })

  it('acts only as an active bot, only with the right key', async () => {
    const botUser = await load(SECRET)
    expect((await botUser(SECRET, 'bot5'))?.username).toBe('bot5')
    expect(await botUser(SECRET, 'alice')).toBeNull() // a player is never reachable
    expect(await botUser(SECRET, 'bot6')).toBeNull() // banned
    expect(await botUser('k'.repeat(39), 'bot5')).toBeNull()
    expect(await botUser(undefined, 'bot5')).toBeNull()
    expect(await botUser(SECRET, 'bot404')).toBeNull()
  })

  it('is off without BOT_HOST_SECRET', async () => {
    const botUser = await load(undefined)
    expect(await botUser('', 'bot5')).toBeNull()
    expect(await botUser(SECRET, 'bot5')).toBeNull()
  })
})

const CORE = join(process.cwd(), 'public/emulator/core/mgba-hub.js')

describe.skipIf(!existsSync(CORE))('bot host (npm run emulator:build)', () => {
  it('plays a game from its folder and sends the site only the code and SHA-1 (NFR-01)', async () => {
    const { Bot } = await import('@/bots/bot')
    const { Site } = await import('@/bots/site')
    // The homebrew cable test program, standing in for a game file (no game data).
    const rom = readFileSync(join(process.cwd(), 'tests/fixtures/link-test.gba'))
    const games = mkdtempSync(join(tmpdir(), 'bot-games-'))
    writeFileSync(join(games, 'test.gba'), rom)

    const sent: { path: string; body: unknown }[] = []
    const emitted: unknown[][] = []
    class FakeSite extends Site {
      async raw(path: string, init: RequestInit = {}) {
        sent.push({ path, body: init.body })
        if (path === '/api/slots') return Response.json({ slots: [{ id: 's1', slotNumber: 1, platform: 'GBA', gameCode: 'ZHLE', origin: 'NEW', currentVersionId: null }] })
        if (path.endsWith('/saves/current')) return new Response(null, { status: 204, headers: { 'x-version-id': 'none' } })
        return Response.json({ versionId: 'v1' })
      }
      socket() {
        const on = () => fake
        const fake = { on, emit: (...a: unknown[]) => emitted.push(a), disconnect() {} }
        return fake as unknown as Socket
      }
    }

    const bot = new Bot('bot5', new FakeSite('http://site.test', 'x'.repeat(32), 'bot5'), games)
    await bot.start()
    await bot.wait(30)
    expect(bot.frames).toBeGreaterThanOrEqual(30)
    // The test program writes its cable role to work RAM, so it really ran (alone, it reads as the child).
    expect(bot.gba!.read32(0x02000000) >>> 0).toBe(4)
    expect(bot.gba!.screenshot().subarray(1, 4).toString()).toBe('PNG')
    await bot.stop()

    const verify = sent.find((s) => s.path === '/api/games/verify')!
    expect(JSON.parse(verify.body as string)).toEqual({ platform: 'GBA', code: 'ZHLE', sha1: createHash('sha1').update(rom).digest('hex') })
    const window = rom.subarray(512, 576)
    for (const s of sent) {
      if (typeof s.body === 'string') expect(s.body.length).toBeLessThan(512)
      else if (s.body) expect(Buffer.from(s.body as Uint8Array).includes(window)).toBe(false)
    }
    expect(JSON.stringify(emitted).length).toBeLessThan(512)
  })

  it("carries a wireless adapter's messages between two bots' games (FR-35)", async () => {
    const { Gba, KEY } = await import('@/bots/core')
    // The homebrew adapter test program (no game data): seat 0 hosts, seat 1 holds A at power-on and joins.
    const rom = readFileSync(join(process.cwd(), 'tests/fixtures/rfu-test.gba'))
    const sides = [await Gba.boot(rom, null), await Gba.boot(rom, null)]
    expect(sides.map((g, seat) => g.plugAir(true, seat))).toEqual([true, true])
    // As the relay: every message to the other seat (or 255, everyone), 2–3 frames late.
    const wire: { at: number; op: number; from: number; d: number[] }[][] = [[], []]
    for (let tick = 0; tick < 900; tick++) {
      sides.forEach((g, seat) => {
        while (wire[seat].length && wire[seat][0].at <= tick) {
          const m = wire[seat].shift()!
          g.putAir(m.op, m.from, m.d)
        }
        g.frame(seat === 1 && tick < 10 ? KEY.A : 0)
        for (const m of g.takeAir()) if (m.to === 255 || m.to === 1 - seat) wire[1 - seat].push({ at: tick + 2 + (tick % 2), op: m.op, from: seat, d: m.d })
      })
    }
    const word = (side: number, offset: number) => sides[side].read32(0x02000000 + offset)
    expect([word(0, 0), word(1, 0)]).toEqual([0, 1]) // host, client
    expect([word(0, 8), word(1, 8)]).toEqual([3, 3]) // both finished
    expect([word(0, 12), word(1, 12)]).toEqual([64, 64]) // every packet arrived, both ways
    expect(sides[0].airTrace()).toContain('command 0x3d') // the stop the program ends with
  })
})
