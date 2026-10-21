import { readFileSync } from 'fs'
import { recoverSlot } from '@/lib/admin-slots'
import { audit, queryAudit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { HttpError } from '@/lib/http'
import { ingestSave } from '@/lib/save-pipeline'

/** FR-24 audit filtering and FR-10 slot recovery, against Postgres, S3 and the save service. */
const LV5 = new Uint8Array(readFileSync('tests/fixtures/synthetic-emerald-lv5.sav'))
const run = Date.now().toString(36)
let n = 0

async function player(role: 'PLAYER' | 'ADMIN' = 'PLAYER') {
  const tag = `${run}_${n++}`
  return prisma.user.create({
    data: { username: `it_${tag}`, email: `it-${tag}@example.test`, passwordHash: 'x', friendCode: newFriendCode(), role },
  })
}

const slot = (userId: string, slotNumber = 1) =>
  prisma.gameSlot.create({ data: { userId, slotNumber, platform: 'GBA', gameCode: 'BPEE', language: 'E', origin: 'NEW' } })

/** Same writes as DELETE /api/slots/:id: soft delete + release its Pokémon. */
async function softDelete(slotId: string, at = new Date()) {
  await prisma.gameSlot.update({ where: { id: slotId }, data: { deletedAt: at } })
  await prisma.pokemonRegistry.updateMany({ where: { currentSlotId: slotId }, data: { currentSlotId: null } })
}

async function savedSlot(userId: string, slotNumber = 1) {
  const s = await slot(userId, slotNumber)
  await ingestSave({ slot: s, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: userId })
  return s
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

describe('queryAudit (FR-24)', () => {
  it('filters by user (as actor or owner of the slot), slot, trade and action, newest first', async () => {
    const [a, b] = [await player(), await player()]
    const [sa, sb] = [await slot(a.id), await slot(b.id)]
    await audit({ actorId: a.id, action: 'slot.create', targetType: 'slot', targetId: sa.id })
    await audit({ actorId: b.id, action: 'slot.create', targetType: 'slot', targetId: sb.id })
    await audit({ actorId: null, action: 'admin.slot.recover', targetType: 'slot', targetId: sa.id })
    await audit({ actorId: b.id, action: 'trade.state', targetType: 'trade', targetId: 't1' })

    const byUser = await queryAudit({ userId: a.id })
    expect(byUser.events.map((e) => e.action)).toEqual(['admin.slot.recover', 'slot.create'])
    expect(byUser.events[1].actor).toBe(a.username)

    expect((await queryAudit({ slotId: sb.id })).events).toHaveLength(1)
    expect((await queryAudit({ tradeId: 't1' })).events[0].action).toBe('trade.state')
    expect((await queryAudit({ action: 'admin.' })).events).toHaveLength(1)
    expect((await queryAudit({ userId: b.id, action: 'trade.' })).events).toHaveLength(1)
  })

  it('pages with a cursor without repeating or skipping', async () => {
    const a = await player()
    for (let i = 0; i < 7; i++) await audit({ actorId: a.id, action: `test.${i}`, targetType: 'user', targetId: a.id })
    const first = await queryAudit({ userId: a.id, limit: 3 })
    const second = await queryAudit({ userId: a.id, limit: 3, cursor: first.nextCursor! })
    const third = await queryAudit({ userId: a.id, limit: 3, cursor: second.nextCursor! })
    const all = [...first.events, ...second.events, ...third.events].map((e) => e.action)
    expect(all).toEqual(['test.6', 'test.5', 'test.4', 'test.3', 'test.2', 'test.1', 'test.0'])
    expect(third.nextCursor).toBeNull()
  })
})

describe('recoverSlot (FR-10)', () => {
  it('brings the slot back, re-claims its Pokémon, and is audit-logged', async () => {
    const [admin, owner] = [await player('ADMIN'), await player()]
    const s = await savedSlot(owner.id, 2)
    await softDelete(s.id)
    expect(await prisma.pokemonRegistry.count({ where: { currentSlotId: s.id } })).toBe(0)

    expect(await recoverSlot(admin, s.id)).toEqual({ slotNumber: 2, conflicts: 0 })
    const after = await prisma.gameSlot.findUniqueOrThrow({ where: { id: s.id } })
    expect(after.deletedAt).toBeNull()
    expect(await prisma.pokemonRegistry.count({ where: { currentSlotId: s.id } })).toBeGreaterThan(0)
    const [event] = (await queryAudit({ slotId: s.id, action: 'admin.' })).events
    expect(event).toMatchObject({ actorId: admin.id, payload: { ownerId: owner.id, slotNumber: 2, conflicts: 0 } })
  })

  it('flags Pokémon another slot has taken since, instead of moving them', async () => {
    const [admin, owner, other] = [await player('ADMIN'), await player(), await player()]
    const s = await savedSlot(owner.id)
    await softDelete(s.id)
    const theirs = await savedSlot(other.id) // the same save turns up in another account

    const r = await recoverSlot(admin, s.id)
    expect(r.conflicts).toBeGreaterThan(0)
    expect(await prisma.pokemonRegistry.count({ where: { currentSlotId: theirs.id, status: 'CLONE_SUSPECT' } })).toBeGreaterThan(0)
    expect(await prisma.saveFlag.count({ where: { version: { slotId: s.id }, kind: 'clone_conflict' } })).toBe(r.conflicts)
  })

  it('moves to a free number, and refuses when full, expired, live or recovered twice', async () => {
    const [admin, owner] = [await player('ADMIN'), await player()]
    const s = await slot(owner.id, 1)
    await softDelete(s.id)
    await slot(owner.id, 1) // number 1 reused
    expect(await recoverSlot(admin, s.id)).toEqual({ slotNumber: 2, conflicts: 0 })
    expect(await code(recoverSlot(admin, s.id))).toBe('not_deleted')

    const full = await slot(owner.id, 3)
    await softDelete(full.id)
    await slot(owner.id, 3)
    expect(await code(recoverSlot(admin, full.id))).toBe('slots_full')

    const old = await slot((await player()).id)
    await softDelete(old.id, new Date(Date.now() - 31 * 24 * 3600 * 1000))
    expect(await code(recoverSlot(admin, old.id))).toBe('recovery_expired')
  })
})
