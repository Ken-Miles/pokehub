# Pokémon Hub — notes for Claude

- Design source of truth: Obsidian vault `~/Documents/obsidian/Pokemon Hub` (requirements FR/NFR, ADRs, phases). Summary + invariants: `docs/design.md`. Keep both in step when a decision changes — add an ADR note for new decisions.
- Stack mirrors Stork v2 (`../stork-v2-automation`): Next.js 16 + custom `server/main.ts`, next-auth, Prisma, Socket.IO. Copy its patterns before inventing new ones.
- Never add code that receives, stores or logs game (ROM) files. Never link to ROM sources.
- Save versions are immutable; every new version goes through `lib/save-pipeline.ts#ingestSave` (or, in phase 2, the trade commit transaction).
- Postgres runs on host port **5433** (5432 is taken by a local Postgres).
- The save service needs .NET 10 — build/test it in Docker (`docker build --target test save-service`), not with the local SDK.
- Run `npm test`, `npm run typecheck` and the save-service tests before calling work done.
