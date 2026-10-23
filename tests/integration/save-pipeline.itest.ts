import { readFileSync } from 'fs'
import type { Platform } from '@prisma/client'
import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { HttpError } from '@/lib/http'
import { ingestSave } from '@/lib/save-pipeline'

/**
 * The save path end to end (ADR-006, ADR-013, FR-20, NFR-07) against the real
 * save service, Postgres and S3. Fixtures are synthetic saves made by PKHeX
 * (tests/fixtures/generate.sh).
 */
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`))
const LV5 = fixture('synthetic-emerald-lv5.sav')
const LV6 = fixture('synthetic-emerald-lv6.sav')
const B2 = fixture('synthetic-black2.sav')
const run = Date.now().toString(36)

async function slotFor(tag: string, platform: Platform = 'GBA', gameCode = 'BPEE') {
  const user = await prisma.user.create({
    data: { username: `it_${run}_${tag}`, email: `it-${run}-${tag}@example.test`, passwordHash: 'x', friendCode: newFriendCode() },
  })
  return prisma.gameSlot.create({
    data: { userId: user.id, slotNumber: 1, platform, gameCode, language: gameCode.slice(3), origin: 'NEW' },
  })
}

const fresh = (id: string) => prisma.gameSlot.findUniqueOrThrow({ where: { id } })

async function rejection(p: Promise<unknown>) {
  try {
    await p
  } catch (e) {
    if (e instanceof HttpError) return { status: e.status, code: e.code }
    throw e
  }
  throw new Error('expected a rejection')
}

// Every test starts from an empty database (pokehub_test only — see vitest.integration.config.ts).
// TRUNCATE doesn't fire the row triggers that keep save_versions and audit_events append-only.
beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, pokemon_registry, audit_events, link_trades CASCADE')
})
afterAll(() => prisma.$disconnect())

describe('Gen 3 save path', () => {
  it('stores a first save, skips an identical one, and chains the next', async () => {
    const slot = await slotFor('chain')
    const first = await ingestSave({ slot, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: slot.userId })
    expect(first).toMatchObject({ created: true, conflicts: [] })
    expect(first.version.seq).toBe(1)

    const same = await ingestSave({ slot: await fresh(slot.id), bytes: LV5, parentVersionId: first.version.id, source: 'EMULATOR', actorId: slot.userId })
    expect(same.created).toBe(false)

    const next = await ingestSave({ slot: await fresh(slot.id), bytes: LV6, parentVersionId: first.version.id, source: 'EMULATOR', actorId: slot.userId })
    expect(next.version).toMatchObject({ seq: 2, parentId: first.version.id })
    expect((await fresh(slot.id)).currentVersionId).toBe(next.version.id)

    const owned = await prisma.pokemonRegistry.findMany({ where: { currentSlotId: slot.id } })
    expect(owned).toHaveLength(1) // one Pikachu, same fingerprint at level 5 and 6
    expect(owned[0]).toMatchObject({ species: 25, status: 'OK', origin: 'NATIVE' })
  })

  it('refuses an upload built on an old version (ADR-006)', async () => {
    const slot = await slotFor('stale')
    const first = await ingestSave({ slot, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: slot.userId })
    await ingestSave({ slot: await fresh(slot.id), bytes: LV6, parentVersionId: first.version.id, source: 'EMULATOR', actorId: slot.userId })
    expect(await rejection(ingestSave({ slot: await fresh(slot.id), bytes: LV5, parentVersionId: first.version.id, source: 'EMULATOR', actorId: slot.userId }))).toEqual({ status: 409, code: 'stale_parent' })
  })

  it('flags the same Pokémon turning up in another player’s slot (FR-20)', async () => {
    const a = await slotFor('owner')
    await ingestSave({ slot: a, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: a.userId })
    const b = await slotFor('copier')
    const copy = await ingestSave({ slot: b, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: b.userId })

    expect(copy.created).toBe(true) // progress is never dropped…
    expect(copy.conflicts).toEqual([expect.objectContaining({ reason: 'owned_by_other_slot', ownerSlotId: a.id })])
    const flags = await prisma.saveFlag.findMany({ where: { versionId: copy.version.id } })
    expect(flags.map((f) => f.kind)).toEqual(['clone_conflict']) // …but the copy is flagged
  })

  it('refuses a save from another platform or game', async () => {
    const slot = await slotFor('wrong')
    expect(await rejection(ingestSave({ slot, bytes: B2, parentVersionId: null, source: 'EMULATOR', actorId: slot.userId }))).toEqual({ status: 413, code: 'bad_size' })
    const ruby = await slotFor('ruby', 'GBA', 'AXVE')
    expect(await rejection(ingestSave({ slot: ruby, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: ruby.userId }))).toEqual({ status: 422, code: 'wrong_game' })
  })
})

describe('later generations are data, not new code (ADR-013)', () => {
  it('ingests a Gen 5 save into a DS slot through the same path', async () => {
    // DS slots can't be created through the API yet (planned for Phase 4); made directly here.
    const slot = await slotFor('black2', 'NDS', 'IREO')
    const first = await ingestSave({ slot, bytes: B2, parentVersionId: null, source: 'IMPORT', actorId: slot.userId })
    expect(first).toMatchObject({ created: true, conflicts: [] })
    const owned = await prisma.pokemonRegistry.findMany({ where: { currentSlotId: slot.id } })
    expect(owned).toEqual([expect.objectContaining({ species: 495, origin: 'IMPORTED' })])
  })
})

describe('link trades (FR-26, FR-37)', () => {
  it('records each Pokémon received from a slot in the same session', async () => {
    const a = await slotFor('giver')
    const b = await slotFor('taker')
    const now = new Date()
    const session = await prisma.linkSession.create({
      data: {
        hostId: a.userId,
        mode: 'CABLE',
        state: 'ACTIVE',
        startedAt: now,
        seats: { create: [{ seat: 0, userId: a.userId, slotId: a.id, readyAt: now }, { seat: 1, userId: b.userId, slotId: b.id, readyAt: now }] },
      },
    })
    await ingestSave({ slot: a, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: a.userId })
    // The same save in B: every Pokémon in it arrived from A over the cable.
    const got = await ingestSave({ slot: b, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: b.userId })
    expect(got.conflicts).toEqual([])

    const trades = await prisma.linkTrade.findMany()
    expect(trades.length).toBeGreaterThan(0)
    expect(trades[0]).toMatchObject({
      sessionId: session.id,
      mode: 'CABLE',
      fromUserId: a.userId,
      fromSlotId: a.id,
      toUserId: b.userId,
      toSlotId: b.id,
      versionId: got.version.id,
    })
    expect(trades[0].speciesName).not.toBe('')
    await expect(prisma.$executeRawUnsafe(`DELETE FROM link_trades`)).rejects.toThrow(/append-only/)
  })
})
