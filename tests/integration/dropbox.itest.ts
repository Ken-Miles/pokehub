import { readFileSync } from 'fs'
import { queryAudit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import {
  deleteDropFile,
  listDropFilesForAdmin,
  listOwnDropFiles,
  listTesters,
  readDropFile,
  setTester,
  uploadDropFile,
} from '@/lib/dropbox'
import { newFriendCode } from '@/lib/friend-code'
import { HttpError } from '@/lib/http'
import { getSave } from '@/lib/storage'

/** FR-32 tester drop box against Postgres, S3 and the save service. */
const LV5 = new Uint8Array(readFileSync('tests/fixtures/synthetic-emerald-lv5.sav'))
const run = Date.now().toString(36)
let n = 0

async function user(opts: { role?: 'PLAYER' | 'ADMIN'; tester?: boolean } = {}) {
  const tag = `${run}_${n++}`
  return prisma.user.create({
    data: {
      username: `it_${tag}`,
      email: `it-${tag}@example.test`,
      passwordHash: 'x',
      friendCode: newFriendCode(),
      role: opts.role ?? 'PLAYER',
      isTester: opts.tester ?? false,
    },
  })
}

async function code(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (e instanceof HttpError) return e.code
    throw e
  }
  return 'ok'
}

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, pokemon_registry, audit_events CASCADE')
})
afterAll(() => prisma.$disconnect())

describe('tester drop box (FR-32)', () => {
  it('stores a readable save with what the save service saw, and an admin downloads the exact bytes', async () => {
    const [tester, admin] = [await user({ tester: true }), await user({ role: 'ADMIN' })]
    const file = await uploadDropFile(tester, { bytes: LV5, fileName: 'Emerald (mGBA).sav', note: ' gym 3 crash ' })
    expect(file).toMatchObject({ readable: true, generation: 3, fileName: 'Emerald (mGBA).sav', note: 'gym 3 crash', size: LV5.length })
    expect(file.storageKey.startsWith(`dropbox/${tester.id}/`)).toBe(true)

    const { bytes } = await readDropFile(admin, file.id)
    expect(Buffer.from(bytes).equals(Buffer.from(LV5))).toBe(true)

    const actions = (await queryAudit({ action: 'dropbox.' })).events.map((e) => e.action)
    expect(actions).toEqual(['dropbox.download', 'dropbox.upload'])
  })

  it('keeps a file the save service cannot read, marked unreadable (ADR-015)', async () => {
    const tester = await user({ tester: true })
    const junk = new Uint8Array(0x20000).map((_, i) => (i * 7) & 0xff)
    const file = await uploadDropFile(tester, { bytes: junk, fileName: 'broken.sav' })
    expect(file.readable).toBe(false)
    expect(file.parseError).toBeTruthy()
    expect((await getSave(file.storageKey)).length).toBe(junk.length)
  })

  it('never creates save versions, slots or registry entries', async () => {
    const tester = await user({ tester: true })
    await uploadDropFile(tester, { bytes: LV5, fileName: 'a.sav' })
    expect(await prisma.saveVersion.count()).toBe(0)
    expect(await prisma.gameSlot.count({ where: { userId: tester.id } })).toBe(0)
    expect(await prisma.pokemonRegistry.count()).toBe(0)
  })

  it('refuses non-testers, game files and oversized files', async () => {
    const [player, tester] = [await user(), await user({ tester: true })]
    expect(await code(uploadDropFile(player, { bytes: LV5, fileName: 'a.sav' }))).toBe('not_tester')
    expect(await code(listOwnDropFiles(player))).toBe('not_tester')
    expect(await code(uploadDropFile(tester, { bytes: new Uint8Array(0x80001), fileName: 'big' }))).toBe('bad_size')

    const rom = new Uint8Array(0x20000)
    rom.set([0x2e, 0x00, 0x00, 0xea], 0)
    rom[0xb2] = 0x96
    let chk = 0
    for (let i = 0xa0; i <= 0xbc; i++) chk = (chk - rom[i]) & 0xff
    rom[0xbd] = (chk - 0x19) & 0xff
    expect(await code(uploadDropFile(tester, { bytes: rom, fileName: 'game.gba' }))).toBe('game_file')
    expect(await prisma.dropFile.count()).toBe(0)
  })

  it('testers see only their own files; only admins download; uploader or admin deletes', async () => {
    const [a, b, admin] = [await user({ tester: true }), await user({ tester: true }), await user({ role: 'ADMIN' })]
    const fa = await uploadDropFile(a, { bytes: LV5, fileName: 'a.sav' })
    const fb = await uploadDropFile(b, { bytes: LV5, fileName: 'b.sav' })

    expect((await listOwnDropFiles(a)).map((f) => f.id)).toEqual([fa.id])
    expect((await listDropFilesForAdmin()).map((f) => [f.fileName, f.uploader])).toEqual([
      ['b.sav', b.username],
      ['a.sav', a.username],
    ])
    expect(await code(readDropFile(a, fa.id))).toBe('forbidden')
    expect(await code(deleteDropFile(a, fb.id))).toBe('not_found')

    await deleteDropFile(a, fa.id)
    await deleteDropFile(admin, fb.id)
    expect(await prisma.dropFile.count()).toBe(0)
    await expect(getSave(fa.storageKey)).rejects.toThrow()
    expect((await queryAudit({ action: 'dropbox.delete' })).events).toHaveLength(2)
  })

  it('admins add and remove testers, audit-logged; files go with the account', async () => {
    const [admin, p] = [await user({ role: 'ADMIN' }), await user()]
    await setTester(admin, p.username.toUpperCase(), true)
    expect((await listTesters()).map((t) => t.username)).toEqual([p.username])
    await setTester(admin, p.username, false)
    expect(await listTesters()).toEqual([])
    expect((await queryAudit({ userId: p.id, action: 'admin.tester' })).events.map((e) => e.action)).toEqual([
      'admin.tester.remove',
      'admin.tester.add',
    ])
    expect(await code(setTester(admin, 'nobody_here', true))).toBe('not_found')

    const t = await user({ tester: true })
    await uploadDropFile(t, { bytes: LV5, fileName: 'a.sav' })
    await prisma.user.delete({ where: { id: t.id } })
    expect(await prisma.dropFile.count()).toBe(0)
  })
})
