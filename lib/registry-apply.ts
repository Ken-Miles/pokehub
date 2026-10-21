import type { Prisma } from '@prisma/client'
import { reconcile, type Conflict, type LinkClaim, type Origin, type SeenPokemon } from '@/lib/registry'

/**
 * Apply the registry rules (FR-20, lib/registry.ts#reconcile) for one save
 * version, inside the caller's transaction. Used by every save ingest
 * (lib/save-pipeline.ts) and by admin slot recovery, so both reconcile the
 * same way. Returns the conflicts it flagged and the link trades it recorded.
 */
export async function applyRegistry(
  tx: Prisma.TransactionClient,
  input: { slotId: string; versionId: string; seen: SeenPokemon[]; newOrigin: Origin; linkPartners?: Set<string> },
): Promise<{ conflicts: Conflict[]; linkClaims: LinkClaim[] }> {
  const { slotId, versionId, seen, newOrigin, linkPartners } = input
  const fingerprints = [...new Set(seen.map((p) => p.fingerprint))]
  const existing = await tx.pokemonRegistry.findMany({
    where: { fingerprint: { in: fingerprints } },
    select: { fingerprint: true, currentSlotId: true, species: true },
  })
  const ownerIds = [...new Set(existing.map((r) => r.currentSlotId).filter((id): id is string => !!id))]
  const live = await tx.gameSlot.findMany({ where: { id: { in: ownerIds }, deletedAt: null }, select: { id: true } })
  const last = await tx.pokemonSighting.findMany({
    where: { fingerprint: { in: fingerprints }, version: { slotId } },
    orderBy: { createdAt: 'desc' },
    distinct: ['fingerprint'],
    select: { fingerprint: true, species: true, level: true },
  })

  const r = reconcile({
    slotId,
    seen,
    existing: new Map(existing.map((e) => [e.fingerprint, e])),
    liveSlotIds: new Set(live.map((s) => s.id)),
    newOrigin,
    lastSightings: new Map(last.map((s) => [s.fingerprint, s])),
    linkPartners,
  })

  if (r.inserts.length) {
    await tx.pokemonRegistry.createMany({
      data: r.inserts.map((p) => ({
        fingerprint: p.fingerprint,
        species: p.species,
        otName: p.otName,
        tid: p.tid,
        sid: p.sid,
        currentSlotId: slotId,
        origin: p.origin,
        firstSeenVersionId: versionId,
      })),
      skipDuplicates: true,
    })
  }
  if (r.claims.length) {
    await tx.pokemonRegistry.updateMany({
      where: { fingerprint: { in: r.claims } },
      data: { currentSlotId: slotId, lastSeenAt: new Date() },
    })
  }
  if (r.linkClaims.length) {
    await tx.pokemonRegistry.updateMany({
      where: { fingerprint: { in: r.linkClaims.map((c) => c.fingerprint) } },
      data: { currentSlotId: slotId, lastSeenAt: new Date() },
    })
  }
  if (r.touches.length) {
    await tx.pokemonRegistry.updateMany({ where: { fingerprint: { in: r.touches } }, data: { lastSeenAt: new Date() } })
  }
  if (r.conflicts.length) {
    // We never drop a player's progress: the save is stored, but every copy of a
    // conflicting Pokémon becomes untradeable until a moderator looks at it.
    await tx.pokemonRegistry.updateMany({
      where: { fingerprint: { in: r.conflicts.map((c) => c.fingerprint) } },
      data: { status: 'CLONE_SUSPECT' },
    })
    await tx.saveFlag.createMany({
      data: r.conflicts.map((c) => ({
        versionId: versionId,
        kind: c.reason === 'duplicate_in_save' ? 'duplicate_in_save' : 'clone_conflict',
        detail: { fingerprint: c.fingerprint, ownerSlotId: c.ownerSlotId },
      })),
    })
  }
  if (r.sightings.length) {
    await tx.pokemonSighting.createMany({
      data: r.sightings.map((p) => ({
        fingerprint: p.fingerprint,
        versionId: versionId,
        species: p.species,
        level: p.level,
        box: p.box,
        slot: p.slot,
      })),
    })
  }
  return { conflicts: r.conflicts, linkClaims: r.linkClaims }
}
