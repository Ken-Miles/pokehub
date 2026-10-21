import { readFileSync } from 'fs'
import { queryAudit } from '@/lib/audit'
import { prisma } from '@/lib/db'
import { newFriendCode } from '@/lib/friend-code'
import { ingestSave } from '@/lib/save-pipeline'
import { purgeDeletedSlots } from '@/lib/slot-purge'
import { getSave } from '@/lib/storage'

/** FR-10 / ADR-017: deleted slots are purged after the 30-day recovery window. */
const fixture = (name: string) => new Uint8Array(readFileSync(`tests/fixtures/${name}`))
const LV5 = fixture('synthetic-emerald-lv5.sav')
const LV6 = fixture('synthetic-emerald-lv6.sav')
const run = Date.now().toString(36)
let n = 0
const DAY = 24 * 3600 * 1000

async function deletedSlot(daysAgo: number) {
  const tag = `${run}_${n++}`
  const user = await prisma.user.create({
    data: { username: `it_${tag}`, email: `it-${tag}@example.test`, passwordHash: 'x', friendCode: newFriendCode() },
  })
  const slot = await prisma.gameSlot.create({
    data: { userId: user.id, slotNumber: 1, platform: 'GBA', gameCode: 'BPEE', language: 'E', origin: 'NEW' },
  })
  const v1 = await ingestSave({ slot, bytes: LV5, parentVersionId: null, source: 'EMULATOR', actorId: user.id })
  const fresh = await prisma.gameSlot.findUniqueOrThrow({ where: { id: slot.id } })
  await ingestSave({ slot: fresh, bytes: LV6, parentVersionId: v1.version.id, source: 'EMULATOR', actorId: user.id })
  // Same writes as DELETE /api/slots/:id, back-dated.
  await prisma.gameSlot.update({ where: { id: slot.id }, data: { deletedAt: new Date(Date.now() - daysAgo * DAY) } })
  await prisma.pokemonRegistry.updateMany({ where: { currentSlotId: slot.id }, data: { currentSlotId: null } })
  const keys = (await prisma.saveVersion.findMany({ where: { slotId: slot.id } })).map((v) => v.storageKey)
  return { slot, user, keys }
}

beforeEach(async () => {
  if (!process.env.DATABASE_URL?.includes('/pokehub_test')) throw new Error('refusing to wipe a non-test database')
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, trades, pokemon_registry, audit_events CASCADE')
})
afterAll(() => prisma.$disconnect())

describe('purgeDeletedSlots', () => {
  it('removes a slot deleted over 30 days ago: rows, blobs, and logs it', async () => {
    const { slot, user, keys } = await deletedSlot(31)
    expect(keys).toHaveLength(2)
    const fingerprints = await prisma.pokemonSighting.count({ where: { version: { slotId: slot.id } } })
    expect(fingerprints).toBeGreaterThan(0)

    expect(await purgeDeletedSlots()).toEqual({ purged: 1, skipped: 0, blobErrors: 0 })
    expect(await prisma.gameSlot.findUnique({ where: { id: slot.id } })).toBeNull()
    expect(await prisma.saveVersion.count({ where: { slotId: slot.id } })).toBe(0)
    expect(await prisma.pokemonSighting.count({ where: { version: { slotId: slot.id } } })).toBe(0)
    for (const key of keys) await expect(getSave(key)).rejects.toThrow()

    // The registry keeps the fingerprints (released), so a copy turning up later is still known.
    expect(await prisma.pokemonRegistry.count()).toBeGreaterThan(0)
    const [event] = (await queryAudit({ slotId: slot.id })).events
    expect(event).toMatchObject({ action: 'slot.purge', actorId: null, payload: { ownerId: user.id, versions: 2 } })
  })

  it('leaves slots still inside the recovery window, and live ones', async () => {
    const { slot } = await deletedSlot(29)
    expect(await purgeDeletedSlots()).toEqual({ purged: 0, skipped: 0, blobErrors: 0 })
    expect(await prisma.gameSlot.findUnique({ where: { id: slot.id } })).not.toBeNull()
  })

  it('does not purge a slot recovered after it was picked up', async () => {
    const { slot, keys } = await deletedSlot(31)
    await prisma.gameSlot.update({ where: { id: slot.id }, data: { deletedAt: null } }) // recovered
    expect((await purgeDeletedSlots()).purged).toBe(0)
    expect(await getSave(keys[0])).toHaveLength(LV5.length)
  })

  it('skips slots that appear in a trade (Phase 2 decides)', async () => {
    const { slot } = await deletedSlot(40)
    await prisma.trade.create({ data: { aSlotId: slot.id, state: 'EXPIRED', expiresAt: new Date() } })
    expect(await purgeDeletedSlots()).toEqual({ purged: 0, skipped: 1, blobErrors: 0 })
  })
})
