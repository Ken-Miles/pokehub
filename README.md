# Pokémon Hub

Play your own Pokémon games in the browser, keep cloud saves with full history,
and (soon) trade with friends. Design: [docs/design.md](docs/design.md) and the
**Pokemon Hub** Obsidian vault.

## Run it locally

Needs Node 20.12+ and Docker.

```bash
cp .env.example .env          # then set NEXTAUTH_SECRET (openssl rand -base64 32)
npm install
npm run services:up           # Postgres :5433, Redis :6379, S3 :9000, save service :5080
npm run db:migrate
npm run dev                   # http://localhost:3000
npm run dev:worker            # second terminal: trade sweeper (+ trade jobs in phase 2)
```

Verification and password-reset emails are printed to the server log in dev.

## Tests

```bash
npm test                                                        # TypeScript unit tests
npm run typecheck
docker build --target test save-service                         # .NET save service tests
```

## Layout

| Path | What |
| --- | --- |
| `app/` | Next.js pages and `/api` route handlers |
| `components/Player.tsx` | Emulator host + cloud save sync |
| `public/emulator/` | Iframe page + glue for EmulatorJS |
| `lib/` | Domain logic — `save-rules.ts`, `registry.ts`, `save-pipeline.ts` hold the anti-duplication rules |
| `server/main.ts` | Custom server: Next.js + Socket.IO |
| `worker/main.ts` | BullMQ worker: trades (phase 2) + sweepers |
| `prisma/` | Schema + migrations (includes hand-written triggers) |
| `save-service/` | .NET 10 + PKHeX.Core save parser |
| `data/rom-hashes.json` | Allowlist of official game dumps (to fill from No-Intro) |
