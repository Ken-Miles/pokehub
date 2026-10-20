# Pokémon Hub — design summary

The full design lives in the Obsidian vault **Pokemon Hub**
(`~/Documents/obsidian/Pokemon Hub`): one note per requirement (FR-01…FR-25,
NFR-01…NFR-12), component notes, phases, and ADR-001…ADR-009. This file is the
short version for anyone reading the code.

## What it is
Players load a backup of a Gen 3 GBA Pokémon game they own into an in-browser
emulator, keep their saves in the cloud with full history, and (phase 2) trade
Pokémon with friends through a server-side trade hub. The server never sees a
game file — only save files (ADR-001).

## Stack (ADR-004 — matches Stork v2)
| Piece | Where |
| --- | --- |
| Web app + API | Next.js 16 + custom `server/main.ts` (Socket.IO on the same port), next-auth credentials/JWT, Prisma, Zod, Tailwind |
| Worker | `worker/main.ts`, BullMQ — trade jobs (phase 2) + sweepers |
| Save service | `save-service/` — .NET 10 + PKHeX.Core, stateless, internal only (ADR-003) |
| Emulator | EmulatorJS, unmodified, in an iframe at `/emulator/` (ADR-009) |
| Data | PostgreSQL (`prisma/schema.prisma`), Redis, S3-compatible storage (R2 prod, SeaweedFS dev) |

## Invariants the code must keep
1. **No game files on the server** (NFR-01). Save routes refuse bodies over
   131,088 bytes before buffering; only header code + SHA-1 of a ROM is sent.
2. **Every save version is immutable** (NFR-07). Content-addressed blob keys;
   a DB trigger blocks rewriting `save_versions`.
3. **Uploads name their parent** (ADR-006). `x-parent-version` must equal the
   slot's current version, else 409. Enforced again by compare-and-swap in the
   ingest transaction (`lib/save-pipeline.ts`).
4. **Registry on every upload** (FR-20). One owning slot per fingerprint
   (PID+TID+SID+OT — never the checksum). A second appearance is kept but marked
   `CLONE_SUSPECT` and flagged; it can't be traded.
5. **No restoring past a trade** (ADR-007). `game_slots.lastTradeVersionId` is
   the barrier (`lib/save-rules.ts#checkRestore`).
6. **Locks live in Postgres only; a trade commits in one transaction** (ADR-005).
   Blobs first (new keys), then one transaction moves both slots, the registry
   and the locks. Sweeper fails trades stuck in `COMMITTING` > 2 min.
7. **Imported saves start unverified** (ADR-008).
8. **Audit log is append-only** (FR-24) — DB trigger.

## Save ingest path
`POST /api/slots/:id/saves` → `checkUpload` (size, lock, parent) →
save service `/parse` → family matches slot's game → SHA-256 (no-op if
unchanged) → put blob → transaction { create version, CAS slot.current,
reconcile registry, flags, sightings, audit } → Socket.IO `slot:updated` so
other tabs stop.

## Production notes
- Save service: run with `network_mode: none` and `LISTEN_SOCKET=/run/savesvc/save.sock`;
  set `SAVE_SERVICE_SOCKET` for the app (NFR-04). Dev uses TCP on 127.0.0.1:5080.
- EmulatorJS: vendor the pinned 4.2.3 release into `public/emulator/data/`
  and point `NEXT_PUBLIC_EMULATORJS_DATA` at it (ADR-009). Dev loads it from
  the EmulatorJS CDN.
- `data/rom-hashes.json` must be filled from the No-Intro DAT before launch;
  `ALLOW_UNLISTED_ROMS` must be `false` in production.
- Web app + worker: systemd, blue/green behind nginx (copy Stork v2's `deploy/`).
