/**
 * Pokémon registry reconciliation (FR-20, ADR-006). Pure: given what a new save
 * version contains and what the registry already knows, decide what to write.
 * Runs on every upload, import, restore and trade — not just at trade time.
 */

export interface SeenPokemon {
  fingerprint: string
  species: number
  level: number
  box: number // -1 = party
  slot: number
  otName: string
  tid: number
  sid: number
}

export interface RegistryRow {
  fingerprint: string
  currentSlotId: string | null // null = released (its slot was deleted)
  species: number
}

export type Origin = 'NATIVE' | 'IMPORTED'

export interface Conflict {
  fingerprint: string
  reason: 'owned_by_other_slot' | 'duplicate_in_save'
  ownerSlotId: string | null
}

export interface ReconcileResult {
  /** New fingerprints to insert, owned by this slot. */
  inserts: (SeenPokemon & { origin: Origin })[]
  /** Released fingerprints (owner slot deleted) this slot now claims. */
  claims: string[]
  /** Already owned by this slot: bump last_seen. */
  touches: string[]
  /** Fingerprints that must be marked CLONE_SUSPECT + flagged. */
  conflicts: Conflict[]
  /** Sightings worth recording (new to this slot, or species/level changed). */
  sightings: SeenPokemon[]
}

export function reconcile(input: {
  slotId: string
  seen: SeenPokemon[]
  existing: Map<string, RegistryRow>
  /** Slots that are still live (not deleted). */
  liveSlotIds: Set<string>
  /** Origin for fingerprints never seen before: IMPORTED for an import, else NATIVE. */
  newOrigin: Origin
  /** Last sighting per fingerprint in this slot, to skip unchanged ones. */
  lastSightings?: Map<string, { species: number; level: number }>
}): ReconcileResult {
  const { slotId, seen, existing, liveSlotIds, newOrigin, lastSightings } = input
  const result: ReconcileResult = { inserts: [], claims: [], touches: [], conflicts: [], sightings: [] }

  const counts = new Map<string, number>()
  for (const p of seen) counts.set(p.fingerprint, (counts.get(p.fingerprint) ?? 0) + 1)

  const handled = new Set<string>()
  for (const p of seen) {
    const prev = lastSightings?.get(p.fingerprint)
    if (!prev || prev.species !== p.species || prev.level !== p.level) result.sightings.push(p)

    if (handled.has(p.fingerprint)) continue
    handled.add(p.fingerprint)

    if ((counts.get(p.fingerprint) ?? 0) > 1) {
      result.conflicts.push({ fingerprint: p.fingerprint, reason: 'duplicate_in_save', ownerSlotId: slotId })
    }

    const row = existing.get(p.fingerprint)
    if (!row) {
      result.inserts.push({ ...p, origin: newOrigin })
    } else if (row.currentSlotId === slotId) {
      result.touches.push(p.fingerprint)
    } else if (row.currentSlotId === null || !liveSlotIds.has(row.currentSlotId)) {
      result.claims.push(p.fingerprint)
    } else {
      // Only trades move Pokémon between slots, and trades update the registry in
      // the same transaction. Showing up anywhere else means it was copied.
      result.conflicts.push({ fingerprint: p.fingerprint, reason: 'owned_by_other_slot', ownerSlotId: row.currentSlotId })
    }
  }
  return result
}
