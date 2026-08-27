# Smart Rot — Ranked Multiplayer Puzzle Platform

Head-to-head ranked puzzle games (Wordle first, then Sudoku, Minesweeper, Spider
Solitaire, ...), chess.com-style: lobby, matchmaking, per-game Glicko-2 ratings,
match history, bot opponents. No real-money features in this phase.

## Status

**Phase 1 (Wordle vertical slice) — backend complete, frontend in progress.**

- [x] Monorepo scaffold (pnpm workspaces + Turborepo)
- [x] `GameEngine` contract + shared domain types (`packages/shared-types`)
- [x] Wordle engine plugin (`packages/game-engines`) — deterministic seeded board, full test suite
- [x] Glicko-2 rating engine (`packages/rating-glicko2`) — verified against the canonical worked example from Glickman's paper
- [x] Postgres schema (users, per-game ratings, match history) + migration
- [x] Clerk auth (JIT user provisioning), REST API (`/api/me`, `/api/matches`)
- [x] Matchmaking (Colyseus `QueueRoom`, expanding rating window) + generic game-room factory + Wordle room
- [ ] Web app: lobby + live match UI (`apps/web`)
- [ ] Bots (Phase 3)

## Architecture decisions

- **Realtime: Colyseus**, not Socket.io. Colyseus's room model (lifecycle, matchmaking hooks, per-client messaging) fits the "server-authoritative room with synced state" shape of these games directly, rather than hand-rolling room/state-sync semantics on a raw pub/sub transport.
- **Auth: Clerk.** Managed provider, minimal Phase-1 boilerplate. The server does JIT user provisioning — the first authenticated request for a new Clerk user creates our `User` row (see `apps/server/src/auth/clerk.ts`); no webhook integration yet, since JIT provisioning covers everything Phase 1 needs, but it means we don't react to profile edits/deletes.
- **Per-game state sync is per-player messaging, not Colyseus schema sync.** `GameEngine.serializeStateForPlayer` intentionally returns a *different* view per player (e.g. a Wordle race hides the opponent's guessed words, only exposing their progress). Colyseus's automatic `@colyseus/schema` state sync broadcasts one shared state to every client, which doesn't fit that. `createGameRoom` (`apps/server/src/rooms/create-game-room.ts`) instead calls `client.send("state", view)` per client after every move.
- **Matchmaking uses Colyseus's built-in `QueueRoom`**, not a hand-rolled Redis sorted-set queue. It already implements exactly the expanding-tolerance matchmaking chess.com/lichess use — see `withinExpandingRatingWindow` in `apps/server/src/matchmaking/matchmaking-room.ts`, which widens the acceptable rating gap the longer a player has waited.
- **The REST API (Fastify) and the Colyseus WebSocket server run on separate ports** (`PORT` / `COLYSEUS_PORT`, default 4000/4001) instead of sharing one `http.Server`. This was discovered the hard way: Colyseus 0.18's `Server` installs its own HTTP request handler on whatever `http.Server` its transport is bound to — unconditionally, not only when its `express` integration option is used — and it collides with any other framework's response on the same server, crashing the process with `ERR_HTTP_HEADERS_SENT` the moment a request hits a route only one of them recognizes. Splitting ports sidesteps it entirely and is a common, legitimate split anyway (REST API and realtime gateway scale differently). See the comment on `env.colyseusPort` in `apps/server/src/env.ts`.
- **`express` is a real dependency of `apps/server` despite the API being Fastify.** `@colyseus/ws-transport`'s compiled output statically `import`s `express` at module load time (used lazily inside `getExpressApp()`, but ESM imports are eager), so the process fails to boot at all without it installed — even though we never call that code path ourselves.
- **`@prisma/adapter-pg` is required.** Prisma 7's `prisma-client` generator (the modern client, used here instead of the legacy `prisma-client-js`) requires a driver adapter to connect to Postgres — see `apps/server/src/db/prisma.ts`.

## Monorepo layout

```
apps/
  server/            Fastify REST API + Colyseus realtime server + Prisma
  web/                Next.js frontend (lobby, live match UI) — in progress
packages/
  shared-types/       GameEngine contract + domain types shared by server & web
  game-engines/       Game plugins (Wordle first) implementing GameEngine
  rating-glicko2/     Glicko-2 rating algorithm, game-agnostic
```

## Local development

Requires Postgres and Redis. `docker-compose.yml` at the repo root starts both
(`docker compose up -d`); on a machine without Docker, native installs work
identically (e.g. `brew install postgresql@14 redis` on macOS) — just make sure
`apps/server/.env`'s `DATABASE_URL`/`REDIS_URL` point at wherever they're running.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env   # then fill in real Clerk keys
pnpm --filter @smart-rot/server db:migrate      # applies migrations AND generates the Prisma client
pnpm --filter @smart-rot/server dev             # REST on :4000, Colyseus WS on :4001
```

Run all package tests: `pnpm test` (or `pnpm --filter <pkg> test` for one package).

### A note on Clerk keys

Phase 1's auth, matchmaking, and match rooms all require a valid Clerk secret
key to verify session tokens — none of that can be exercised end-to-end without
real Clerk API keys (dashboard.clerk.com). The `.env.example` placeholders are
enough for the server to boot and for the REST/Colyseus co-hosting fix above to
be verified, but not for a real signed-in match.
