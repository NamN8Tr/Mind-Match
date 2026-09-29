# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Smart Rot is a ranked head-to-head puzzle platform (chess.com-style lobby → matchmaking → server-authoritative match → per-mode Glicko-2 rating), plus unranked timed solo runs with personal bests. Games shipped so far: **Wordle** (Speed, Fewest Guesses, Speed Solo) and **Spider Solitaire** (1/2/3/4-suit, ranked + solo).

`README.md` and `docs/PROJECT_CONTEXT.md` hold the design rationale, the chronological history (§1–20), the verification matrix, the continuation plan, and the fixed Clerk test-account policy. When you finish a notable change, add a history entry there and update the matrix and test counts.

## Commands

pnpm workspaces + Turborepo. Node >= 20, pnpm 11.

```bash
pnpm launch                 # ./scripts/dev.sh: env files, Postgres/Redis, migrate, solver build, both dev servers
./scripts/dev.sh --restart  # take over ports 3000/4000/4001 if already held (see --help for other flags)

pnpm typecheck && pnpm lint && pnpm test && pnpm build   # the quality gates
pnpm test --force                                         # turbo caches test results; force a real rerun
pnpm --filter @smart-rot/server smoke:live                # real Clerk JWTs against running :4000/:4001
```

Run a single test file or test (all packages use `node:test` via `tsx`):

```bash
pnpm --filter @smart-rot/game-engines exec tsx --test src/wordle/engine.test.ts
pnpm --filter @smart-rot/server exec tsx --test --test-timeout=25000 --test-name-pattern="reconnect" src/integration.test.ts
pnpm --filter @smart-rot/web test
```

- **Server tests need Postgres and Redis running** (`docker compose up -d`). They use the real DB, real Redis session locks, and real Colyseus rooms. Only Clerk is faked, at the `clerkAuth` seam in `apps/server/src/auth/clerk.ts`, where the token string is treated as the Clerk subject. Each suite namespaces its users by prefix (`it-`, `api-`) and cleans them up.
- Integration tests build Colyseus with `createColyseusServer({ isolated: true })` (process-local presence/driver) so a running dev gateway on the same Redis can't steal test rooms. Room timings are injectable via `gameRoom` / `soloRoom` options.
- `pnpm lint` only lints `apps/web` (ESLint flat config; Next 16 removed `next lint`). The other packages rely on `tsc` alone.
- Prisma (server): `pnpm db:migrate` (`prisma migrate dev`), `pnpm db:generate`. The client is generated into `apps/server/src/generated/prisma/` (gitignored) and imported from `../generated/prisma/client.js`, so regenerate after any schema change. Prisma 7 config lives in `apps/server/prisma7.config.ts`.
- `pnpm build` first compiles the C++17 Spider solver (`tools/spider-solver/build.sh`, needs `c++`) into the gitignored `tools/spider-solver/bin/`.

## Architecture

```
packages/shared-types    GameEngine contract + all domain/message types (the only package apps/web depends on)
packages/game-engines    Game plugins implementing GameEngine (wordle/, spider/)
packages/rating-glicko2  Game-agnostic Glicko-2
apps/server              Fastify REST (:4000) + Colyseus realtime (:4001) + Prisma/Postgres + Redis
apps/web                 Next.js 16 App Router + Clerk
tools/spider-solver      Standalone C++ solver that produces certified-solvable Spider deals
```

Workspace packages have no build step. Their `exports` point at `src/index.ts` and are consumed as TypeScript source. The server is ESM with `NodeNext` resolution, so relative imports need `.js` extensions.

### Games are plugins behind `GameEngine<State, Move>`

`packages/shared-types/src/game-engine.ts` is the contract. Matchmaking, room orchestration, finalization, and ratings only ever touch this interface. Adding a game or mode means:

1. Write an engine per mode in `packages/game-engines`.
2. Add types in `shared-types/src/games/`.
3. Extend `GameId`.
4. Register rooms in `apps/server/src/colyseus-server.ts`. Each mode gets `<name>` (match room via `createGameRoom`), `<name>_matchmaking` (`createMatchmakingRoom(gameId, mode, matchRoomName)`), and optionally `<name>_solo`.
5. Add the mode to `SUPPORTED_RATING_POOLS` in `apps/server/src/routes/api.ts`, so `/api/me` provisions its rating.
6. Add the mode to `ACHIEVEMENT_MODES` in `apps/web/lib/achievements.ts`.
7. Build the UI. The web client joins rooms by these exact string names.

If the generic layers start needing game-specific branches, extend the contract or `GameRoomOptions` instead. Existing examples are `getTimeoutResult`, `serializeStateForPersistence`, `idleTimeoutMs`, `departurePolicy`, and `prepareSeed`. Every ranked opponent must receive the same seeded board.

### Invariants that fail quietly if broken

- **A Clerk subject is not a `PlayerId`.** All internal ids (`Rating.userId`, room `playerIds`, participants) are Prisma `User.id` cuids. Every authenticated REST/WebSocket entry point must go through `resolveAuthenticatedUser()` in `apps/server/src/auth/clerk.ts`, which verifies the token and JIT-provisions/resolves the internal user. Never call `verifyClerkAuthToken` directly. Getting this wrong only surfaces as an FK violation once two real players are matched.
- **Server-authoritative, per-player views.** Clients send `move` intents. The engine validates them by throwing `GameRuleViolation`, which the room turns into a rejection message. State is sent with `client.send("state", engine.serializeStateForPlayer(...))` per client, **not** Colyseus schema sync, because views differ per player (e.g. the Wordle opponent view carries colors but never letters).
- **The `ready` handshake.** Rooms send nothing from `onJoin`. The client attaches its `phase`/`countdown`/`clock`/`state`/`result` listeners, then sends `ready`, and only then gets a snapshot. Both players being ready starts a server-timed 3s countdown before moves or the clock are accepted. Reconnecting clients repeat `ready`.
- **Finalization is one transaction and exactly-once.** `finalizeMatch()` in `apps/server/src/matchmaking/match-service.ts` writes the match result, both participant snapshots, and both rating rows together. The conditional `ACTIVE → terminal` update is the idempotency claim. Clients get the result only after persistence; if it fails, they get `persisted: false`. Never update ratings anywhere else.
- **Redis session lock ownership moves with the handoff.** One queue entry or match per user per game (`matchmaking/session-lock.ts`). Matchmaking owns and releases the lock until the match is created, then `finalizeMatch()` releases it.
- **Ratings are keyed `(userId, gameId, mode)`.** Each mode has an independent pool starting at rating 400 / deviation 100, and `gameId`/`mode` are plain strings, so adding a mode needs no migration. Personal bests use the same key and a conditional "only if faster" write. Solo rooms never create matches or touch ratings.
- **Separate ports are deliberate.** Colyseus 0.18 installs its own HTTP handler on whatever server it's bound to and collides with Fastify (`ERR_HTTP_HEADERS_SENT`). `express` is a real server dependency only because `@colyseus/ws-transport` imports it at load time.
- On boot, `abortStaleActiveMatches()` reaps `ACTIVE` matches orphaned by a previous process.

### Spider board supply

Spider deals must be provably solvable, and `generateInitialState` is synchronous, so boards are produced ahead of time:

- `SpiderBoardPool` (`apps/server/src/spider-board-pool/service.ts`) runs a background refill loop. It shells out to the C++ solver (`SPIDER_SOLVER_PATH` overrides the binary path), uses per-mode search budgets and a Redis refill lock, and **replays every solver witness through the TS engine (`verifySpiderDeal`) before inserting** into the `spider_boards` table. Solver output is treated as untrusted.
- A room's `prepareSeed` hook claims a stored board (serializable delete-on-claim) and pins it to the room seed with `registerSpiderDealAssignment()` (an in-memory map in the engine), *before* `generateInitialState` runs in the same process.
- If the pool is empty or the solver binary is missing, the engine falls back to the bundled `packages/game-engines/src/spider/verified-board-pool.json`. It serves isomorphic transforms (column and suit permutation) of those boards, which keep the saved win path valid. The server boots fine without the solver.
- Spider ranked rooms differ from Wordle through room options: an idle timeout instead of a wall-clock cap, `departurePolicy: "continue-until-both-leave"`, and a ranked solve also recording a timed personal best.

### Web client

- **Next.js 16 has breaking changes versus most training data.** Read the relevant guide in `apps/web/node_modules/next/dist/docs/` before writing Next code (see `apps/web/AGENTS.md`, which `next dev` regenerates).
- Clerk Core 3: use `<Show when="signed-in">` (`<SignedIn>`/`<SignedOut>`/`<Protect>` are gone). `proxy.ts` runs `clerkMiddleware()` for session context only. The real auth boundary is the server verifying the token on every REST and Colyseus call (passed as `authToken` in join options).
- `apps/web` depends only on `@smart-rot/shared-types`, never on `game-engines`. Client-side helpers like `lib/spider-hints.ts` are UX only; the server re-validates everything.
- Shared web helpers live in `lib/`: `format.ts` (`formatTime`, m:ss.t) and `achievements.ts` (mode catalog plus `isSameMode()`). Use them rather than redefining per component. Spider originally persisted its only mode as `speed`, and `isSameMode()` maps those legacy rows to `1-suit`.
- `next-env.d.ts` is gitignored and regenerated (`next typegen` runs inside the web `typecheck`). Don't commit it.
- Match handoff: matchmaking consumes the seat reservation, stashes the live `Room` in `lib/pending-match.ts` (in-memory, survives client-side navigation), and routes to the canonical match URL. The reconnection token is persisted in `sessionStorage` (`lib/match-storage.ts`) so a hard refresh reconnects instead of rejoining.
- React Strict Mode double-runs effects in dev. The match pages (`app/match/[roomId]`, `app/games/spider/match/[roomId]`) keep one in-flight connection promise in a ref and defer the unmount `leave()` with a cancelable timer, because a discarded duplicate calling a consented `room.leave()` becomes a real forfeit. They load the profile and room with `Promise.allSettled` and leave the room if the profile fetch fails, so an error screen never strands a seated connection. Keep both patterns in any new room page.
- Live-match links to `/players/[userId]` open in a new tab so viewing a profile doesn't navigate away and forfeit.
- If a Clerk "React Client Manifest" / module-path error appears after `pnpm install`, stop the web dev server and clear `apps/web/.next/dev` before debugging app code.

## Environment and test accounts

- `apps/server/.env` needs `DATABASE_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `WEB_ORIGIN` (an exact CORS origin; there's no wildcard), plus `PORT` and `COLYSEUS_PORT`.
- `apps/web/.env.local` needs the same Clerk app's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `CLERK_SECRET_KEY`, plus `NEXT_PUBLIC_API_URL` and `NEXT_PUBLIC_COLYSEUS_URL`.
- Don't overwrite existing env files, and never copy their values into code, docs, or logs.
- Use only the two fixed Clerk test users: `smartrot-player-one+clerk_test@example.com` and `smartrot-player-two+clerk_test@example.com`, with verification code `424242`. Never create extra Clerk users per run and never delete these two. `smoke:live` reuses them and revokes only its own sessions.

## Scope

No real-money features (wagering, wallets, token purchases, withdrawals) belong in this codebase.
