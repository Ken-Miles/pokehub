import { reconcile, type RegistryRow, type SeenPokemon } from '@/lib/registry'

const mon = (fingerprint: string, over: Partial<SeenPokemon> = {}): SeenPokemon => ({
  fingerprint,
  species: 25,
  level: 5,
  box: 0,
  slot: 0,
  otName: 'ASH',
  tid: 1,
  sid: 2,
  ...over,
})
const row = (fingerprint: string, currentSlotId: string | null): RegistryRow => ({ fingerprint, currentSlotId, species: 25 })

const base = { slotId: 'A', liveSlotIds: new Set(['A', 'B']), newOrigin: 'NATIVE' as const }

describe('reconcile (FR-20)', () => {
  it('inserts never-seen Pokémon with the given origin', () => {
    const r = reconcile({ ...base, seen: [mon('f1')], existing: new Map(), newOrigin: 'IMPORTED' })
    expect(r.inserts).toHaveLength(1)
    expect(r.inserts[0].origin).toBe('IMPORTED')
    expect(r.conflicts).toEqual([])
  })

  it('touches Pokémon this slot already owns', () => {
    const r = reconcile({ ...base, seen: [mon('f1')], existing: new Map([['f1', row('f1', 'A')]]) })
    expect(r.touches).toEqual(['f1'])
    expect(r.conflicts).toEqual([])
  })

  it("flags a Pokémon owned by another live slot — e.g. a pre-trade save state re-saved", () => {
    const r = reconcile({ ...base, seen: [mon('f1')], existing: new Map([['f1', row('f1', 'B')]]) })
    expect(r.conflicts).toEqual([{ fingerprint: 'f1', reason: 'owned_by_other_slot', ownerSlotId: 'B' }])
    expect(r.inserts).toEqual([])
  })

  it('lets a slot claim Pokémon released by a deleted slot', () => {
    const r = reconcile({ ...base, seen: [mon('f1'), mon('f2')], existing: new Map([['f1', row('f1', null)], ['f2', row('f2', 'gone')]]) })
    expect(r.claims).toEqual(['f1', 'f2'])
    expect(r.conflicts).toEqual([])
  })

  it('flags the same Pokémon twice in one save', () => {
    const r = reconcile({ ...base, seen: [mon('f1', { box: 0 }), mon('f1', { box: 3 })], existing: new Map() })
    expect(r.conflicts).toEqual([{ fingerprint: 'f1', reason: 'duplicate_in_save', ownerSlotId: 'A' }])
    expect(r.inserts).toHaveLength(1)
  })

  it('records sightings only when something changed', () => {
    const last = new Map([['f1', { species: 25, level: 5 }], ['f2', { species: 25, level: 5 }]])
    const r = reconcile({
      ...base,
      seen: [mon('f1'), mon('f2', { level: 6 }), mon('f3')],
      existing: new Map([['f1', row('f1', 'A')], ['f2', row('f2', 'A')]]),
      lastSightings: last,
    })
    expect(r.sightings.map((s) => s.fingerprint)).toEqual(['f2', 'f3'])
  })
})

describe('reconcile: link trades (FR-26)', () => {
  const live = new Set(['A', 'B', 'C'])

  it('moves a Pokémon from a slot in the same link session', () => {
    const r = reconcile({ ...base, liveSlotIds: live, seen: [mon('f1')], existing: new Map([['f1', row('f1', 'B')]]), linkPartners: new Set(['B']) })
    expect(r.linkClaims).toEqual([{ fingerprint: 'f1', fromSlotId: 'B' }])
    expect(r.conflicts).toEqual([])
  })

  it('still flags a Pokémon from a slot outside the session', () => {
    const r = reconcile({ ...base, liveSlotIds: live, seen: [mon('f1')], existing: new Map([['f1', row('f1', 'C')]]), linkPartners: new Set(['B']) })
    expect(r.linkClaims).toEqual([])
    expect(r.conflicts).toEqual([{ fingerprint: 'f1', reason: 'owned_by_other_slot', ownerSlotId: 'C' }])
  })

  it('never claims a Pokémon that appears twice in the save, even from a partner', () => {
    const r = reconcile({
      ...base,
      liveSlotIds: live,
      seen: [mon('f1', { box: 0 }), mon('f1', { box: 1 })],
      existing: new Map([['f1', row('f1', 'B')]]),
      linkPartners: new Set(['B']),
    })
    expect(r.linkClaims).toEqual([])
    expect(r.conflicts.map((c) => c.reason)).toEqual(['duplicate_in_save', 'owned_by_other_slot'])
  })

  it('makes no link claims without partners (imports, restores, no session)', () => {
    const r = reconcile({ ...base, liveSlotIds: live, seen: [mon('f1')], existing: new Map([['f1', row('f1', 'B')]]) })
    expect(r.linkClaims).toEqual([])
    expect(r.conflicts).toHaveLength(1)
  })

  it('keeps ordinary handling for Pokémon the slot owns or never saw', () => {
    const r = reconcile({
      ...base,
      liveSlotIds: live,
      seen: [mon('f1'), mon('f2')],
      existing: new Map([['f1', row('f1', 'A')]]),
      linkPartners: new Set(['B']),
    })
    expect(r.touches).toEqual(['f1'])
    expect(r.inserts.map((p) => p.fingerprint)).toEqual(['f2'])
    expect(r.linkClaims).toEqual([])
  })
})
