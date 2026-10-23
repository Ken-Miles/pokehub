# Pokémon Hub — design summary

The full design lives in the Obsidian vault **Pokemon Hub**
(`~/Documents/obsidian/Pokemon Hub`): one note per requirement (FR-01…FR-37,
NFR-01…NFR-13), component notes, phases, and ADR-001…ADR-025. This file is the
short version for anyone reading the code.

## What it is
Players load a backup of a Gen 3 GBA Pokémon game they own into an in-browser
emulator, keep their saves in the cloud with full history, and play together:
live link sessions between running games (Phase 1b) and a server-side trade hub
(Phase 2). Multiplayer is designed in from the start (ADR-010). The server never sees a
game file — only save files (ADR-001).

## Stack (ADR-004 — matches Stork v2)
| Piece | Where |
| --- | --- |
| Web app + API | Next.js 16 + custom `server/main.ts` (Socket.IO on the same port), next-auth credentials/JWT, Prisma, Zod, Tailwind |
| Worker | `worker/main.ts`, BullMQ — trade jobs (phase 2) + sweepers |
| Save service | `save-service/` — .NET 10 + PKHeX.Core, stateless, internal only (ADR-003) |
| Emulator | Our WebAssembly build of unmodified mGBA 0.10.5 (`emulator/`, glue in `emulator/src/hub.c`) → `public/emulator/core/`, in an iframe at `/emulator/`; 1–4 linked GBAs in one thread (ADR-011, ADR-018; EmulatorJS/ADR-009 superseded) |
| Data | PostgreSQL (`prisma/schema.prisma`), Redis, S3-compatible storage (R2 prod, SeaweedFS dev) |

## Invariants the code must keep
1. **No game files on the server** (NFR-01). Save routes refuse bodies larger
   than the slot's platform allows before buffering (GBA 131,088 bytes, largest
   of any platform 512 KB); only platform + header code + SHA-1 of a ROM is sent.
   The one exception is the separate bot host (ADR-023), which reads games from
   a read-only folder an operator fills by hand; nothing sends it a game file.
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
9. **Tester drop-box files are not save versions** (FR-32, ADR-015).
   Testers upload save-sized files for the owner to download; same size cap and
   ROM-header refusal, kept even if unparseable, never in slots, registry or trades.
   `lib/dropbox.ts` never calls `ingestSave`; blobs live under `dropbox/` and can
   be deleted at any time (`lib/storage.ts#deleteDropBlob`); save-version blobs
   only by a slot purge (11).
10. **Save states never leave the tab** (ADR-016). Only the emulator page's
    nine in-memory slots (hotkeys); none at all while linked; the Player clears
    them whenever the cloud save changes without this tab.
11. **Deleted slots are purged after 30 days** (ADR-017). Until then an admin can
    recover them; then the worker removes the rows and blobs (`lib/slot-purge.ts`
    is the only code allowed to delete save-version blobs).

## Games (ADR-013)
Every Gen 3–7 game is data in `lib/games.ts`: platform (GBA / NDS / N3DS),
generation, save format, sizes, emulator core. Only GBA is `playable`; NDS
(Phase 4, browser) and N3DS (Phase 6, desktop Azahar + companion app) are
`planned` and refused with their phase. A slot's game is **platform + code**
(DS codes reuse GBA ones). The save service already reads every Gen 3–7 format;
the clone fingerprint (`pk1:` PID+TID+SID+OT) is the same in every generation.
Switching a platform on = emulator work + its availability flag, not new paths
through the save pipeline.

## Multiplayer (ADR-010…012, ADR-018)
- Gen 3 link play is a virtual cable. Measured (vault: *Link latency
  experiments*, code: `spikes/link-latency/`): relaying the cable's 9
  transfers per frame drops the game to 21% speed at 9 ms round trips;
  **lockstep** (every browser runs every game, only inputs travel) holds full
  speed with 2–3 frames of input delay at same-region latency. Decided:
  lockstep, over WebRTC with the server relay as fallback (ADR-012).
- Our own mGBA WebAssembly build makes that possible (ADR-011): one module runs
  1–4 GBAs on mGBA's own cable in a single thread, in a fixed order, so every
  browser fed the same inputs gets the same result (ADR-018).
- Lockstep never moves game files: each player loads their own copy of every
  game in the session.
- In-game link trades are reconciled from uploaded saves: a Pokémon may move
  only between slots in the same recorded link session (while it runs or within
  `LINK_GRACE_MS` after; emulator saves only), and the restore barrier moves on
  both slots (`lib/save-pipeline.ts`, `lib/registry.ts`). No save states while
  linked.
- Every Pokémon received that way is a row in `link_trades` (FR-37, ADR-025):
  append-only, plain ids, written in the ingest transaction; admins read it at
  `/admin/trades`. In-game saves upload on their own; the play and link pages ask
  before closing a tab whose save is still uploading.
- A session starts only when every seat has a slot, a game file whose SHA-1 is
  on the allowlist, and the same emulator build (`public/emulator/core/build.json`).
  Start pins each seat's save version, a shared clock value and the input delay.
  A state-hash mismatch ends the session (`desync`).
- Built: `/link` (FR-26) with same-device sessions (one account's own slots in
  one page) and network sessions (lockstep inputs over WebRTC data channels,
  `lib/client/peer-link.ts`, host candidates only so direct on one network or
  cable; through the Socket.IO relay, `lib/link-relay.ts`, while any peer's
  channel isn't open, and a dropped channel re-sends its last inputs there; the
  host picks the input delay from its doubled round trip to the site). Rules in
  `lib/link-rules.ts`, I/O in `lib/link-sessions.ts`, schedule in
  `lib/client/lockstep.ts`.
- Not built: STUN/TURN, reconnecting a dropped channel, each peer's own round trip in the delay,
  the Emerald Multiplayer hack flow (FR-31; the core can already apply a patch).
  Not verified: a real Cable Club battle and trade; full speed in all three
  browsers (NFR-09).
- Gen 4–5 later: our own replacement for Nintendo Wi-Fi Connection (Phase 5).

## The link cable and the Wireless Adapter (ADR-019…022)
- Platform `GB`: Red, Green (Japan), Blue, Yellow; codes `APA`/`APG`/`APE`/`APS` + `J` or
  `O`. Headers carry no code, so `lib/client/rom.ts` finds it by SHA-1. Saves are 32 KB,
  family `RBY`; a Japanese save never goes into an international slot (and back).
- Clone fingerprint for Gen 1: `gb1:<base species>:<DVs>:<TID>:<OT>` (no PID in Gen 1).
- Trading happens in the games: each player runs only their own game and a network
  serial driver (`emulator/src/hub.c`) relays cable bytes. Plugging in from the play
  page (`components/LinkCable.tsx`, `lib/cable.ts`, `/api/cable/*`) creates a two-seat
  `CABLE` link session, so link-trade reconciliation and the restore barrier apply.
- Presence (who's playing what) lives in the web process (`lib/realtime.ts`), like the
  relay: one web process until both move to Redis.
- Gen 3 uses the same cable from the play page (ADR-021): each player runs only their
  own GBA game; the requester is the cable's parent, the child's words arrive `delay`
  frames late (from the measured round trip), and the parent holds frames back rather
  than desync. Lockstep (`/link`) stays for same-device and 3–4-player sessions.
- Wireless Adapter rooms (FR-35, ADR-022, ADR-024): FireRed, LeafGreen and Emerald players
  open a `WIRELESS` link session of up to 16 (`lib/wireless.ts`, `/api/wireless/*`,
  `components/Wireless.tsx`); our core emulates the adapter and only adapter messages
  cross the relay. A room is radio range: beacons reach everyone, while a link (a
  host and at most 4 children) is the emulated adapter's business, never the site's,
  and the relay sends a message for one seat only to that seat's page. Members join and leave while the room runs (`link_seats.leftAt`);
  only seats that joined count as link-trade partners. Cable and adapter share the
  GBA's one serial port, so the play page offers one at a time.
- Relay state lives in the web process, so at startup the relay ends every link it was
  carrying (`lib/link-sessions.ts#endOrphanedLinks`), and a page whose relay connection
  drops turns its cable or adapter off.

## Test bots (FR-36, ADR-023)
- A separate bot host (`bots/main.ts`, its own container) runs bot players on our
  mGBA core in Node, one worker thread each, with games from a hand-filled
  read-only folder. It is the only place outside a browser that holds a game file.
- Bots are accounts with `isBot`, created by an admin, friend codes `0000-0000-NNNN`
  (never given to players). They can't sign in; the bot host acts for them with its
  own secret (not `NEXTAUTH_SECRET`) and goes through the real cable, wireless,
  relay and save-upload paths.
- `/admin/bots` turns bots on/off, sets game, base save and settings, and shows a
  live screen with button input. Commands are goals ("bot5 accept a trade from
  bot16"); the bot host's coordinator turns them into steps checked against game
  memory (addresses per ROM revision).
- Open: resetting a bot after a trade vs. clone detection and the restore barrier.
- Built (P0): `isBot`, `lib/bot-auth.ts` (`x-bot-key` + `x-bot` headers / socket auth,
  `BOT_HOST_SECRET`), `npm run bots:create`, and `bots/` (`npm run bots`): one thread,
  cable only, Emerald (US) Trade Center steps in `bots/emerald.ts` — not yet run against
  the real game. Wireless rooms built since.
- Built: `/admin/bots` live view (`lib/bot-watch.ts`): bots send PNG screens at 10 fps
  only while an admin is watching; the site relays them to admins only. One watching
  admin at a time takes control of a bot: their buttons replace the bot's, the bot's
  frame waits stop (so its commands pause), and control returns when they give it back,
  stop watching or drop. Taking/returning control is audited (`bot.control`,
  `bot.release`). Not built: bot settings from the page, worker threads.

## Save ingest path
`POST /api/slots/:id/saves` → `checkUpload` (size, lock, parent) →
save service `/parse` → family matches slot's game → SHA-256 (no-op if
unchanged) → put blob → transaction { create version, CAS slot.current,
reconcile registry, flags, sightings, audit } → Socket.IO `slot:updated` so
other tabs stop.

## Production notes
- Save service: run with `network_mode: none` and `LISTEN_SOCKET=/run/savesvc/save.sock`;
  set `SAVE_SERVICE_SOCKET` for the app (NFR-04). Dev uses TCP on 127.0.0.1:5080.
- Emulator: `public/emulator/core/` is committed build output; rebuild it with
  `scripts/build-emulator.sh` (Docker, pinned mGBA and Emscripten). A new build
  changes the hash in `build.json`, and a link session won't start until every
  player has reloaded onto the same build.
- Link relay: session state lives in one process (`lib/link-relay.ts`). Before
  running more than one web process, route all of a session's sockets to the
  same one.
- `data/rom-hashes.json` must be filled from the No-Intro DAT before launch;
  `ALLOW_UNLISTED_ROMS` must be `false` in production.
- Web app + worker: systemd, blue/green behind nginx (copy Stork v2's `deploy/`).
  Set `TRUSTED_PROXY_HOPS=1` behind that nginx (2 if a CDN sits in front of it):
  `server/main.ts` resolves the client IP for rate limits from the socket address
  and that many `X-Forwarded-For` hops, and nginx must append with
  `$proxy_add_x_forwarded_for`. Routes read only `lib/client-ip.ts#clientIp`, never
  the raw headers, whose first entries the client controls.
