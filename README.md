# Smart Rot — Ranked Multiplayer Puzzle Platform

Head-to-head ranked puzzle games (Wordle first, then Sudoku, Minesweeper, Spider
Solitaire, …), chess.com-style: lobby, matchmaking, per-game Glicko-2 ratings,
match history, bot opponents. No real-money features in this phase.

## Status

**Phase 1 (Wordle vertical slice) — complete and covered by automated tests,
pending a manual two-account smoke test.**

- [x] Monorepo scaffold (pnpm workspaces + Turborepo)
- [x] `GameEngine` contract + shared domain types (`packages/shared-types`)
- [x] Wordle engine plugin — deterministic seeded puzzle, 9 unit tests
- [x] Glicko-2 rating engine — verified against the worked example in Glickman's paper
- [x] Postgres schema (users, per-game ratings, match history) + migration
- [x] Clerk auth with JIT user provisioning; REST API (`/api/me`, `/api/matches`) with CORS
- [x] Matchmaking (expanding rating window), generic game-room factory, Wordle room
- [x] Match lifecycle: join deadline, reconnect grace, match timeout, stale-match reaper
- [x] Atomic + idempotent match finalization
- [x] Web app: lobby, live match UI, refresh-safe reconnect
- [x] 14 server tests (8 realtime integration + 6 REST), 14 package unit tests
- [ ] **Manual smoke test with two real Clerk accounts** (see "Verification status")
- [ ] Phase 2: Sudoku and Minesweeper
- [ ] Phase 3: bots

## Architecture decisions

### Identity: a Clerk subject is not a `PlayerId`

The single most important invariant in this codebase. Verifying a Clerk token
yields a **Clerk subject** — an id in Clerk's namespace. Every internal id
(`Rating.userId`, match participants, the `playerIds` a room authorizes against)
is our own Prisma `User.id` (a cuid). Mixing them up doesn't fail loudly; it
fails as a foreign-key violation deep inside rating persistence, only once two
real players are actually matched.

Every authenticated entry point therefore goes through the single
`resolveAuthenticatedUser()` in `apps/server/src/auth/clerk.ts`, which verifies
the token *and* resolves it to the internal `User`. Nothing else should call
`verifyClerkAuthToken` directly. This is regression-tested from both directions
(`/api/me` must report the internal id; matchmaking must key ratings by it).

### Realtime: Colyseus, not Socket.io

Colyseus's room model (lifecycle hooks, matchmaking, seat reservations,
reconnection tokens) matches the "server-authoritative room with synced state"
shape of these games directly. Socket.io would mean hand-rolling room
lifecycle, reconnection, and state-sync semantics on a raw pub/sub transport.

### Per-player state sync is message-passing, not Colyseus schema sync

`GameEngine.serializeStateForPlayer` deliberately returns a **different view per
player** — a Wordle race exposes your opponent's *progress* but never their
guessed words. Colyseus's `@colyseus/schema` sync broadcasts one shared state to
everyone, which can't express that. So `createGameRoom` sends `client.send("state", view)`
per client instead. Enforced by a test asserting the opponent view carries no words.

### The client asks for its opening state; the server never pushes it unprompted

A room sends nothing from `onJoin`. The client attaches its listeners, then
sends `ready`, and only then does the server reply with `phase` + `state`.
Pushing from `onJoin` looks simpler and works most of the time, which is what
makes it dangerous: Colyseus flushes those messages the moment the socket is up,
which can land *before* the client has subscribed — silently dropping the only
copy of the initial state. `ready` is also what starts the match, so "both
players present" means "both players can actually receive", not merely "both
sockets connected".

### Match lifecycle

Handled generically in `createGameRoom` so every future game inherits it:

| Situation | Behavior |
| --- | --- |
| Both players `ready` | Match starts; moves accepted; timeout clock starts |
| Move before both ready | Rejected with a reason, never silently dropped |
| Nobody joins within 30s | Aborted, **no rating change** |
| Connection drops | 20s reconnect grace; resuming restores full state |
| Grace expires | Forfeit to the opponent |
| Nobody solves in 5 min | Draw |
| Server restarts mid-match | `abortStaleActiveMatches()` reaps orphaned ACTIVE rows at boot |

A user can hold only one queue entry or match per game at a time, enforced by a
Redis session lock (`matchmaking/session-lock.ts`) with a TTL as a crash-safety
net. The lock is released by whichever side legitimately owns the handoff —
matchmaking on leave, or `finalizeMatch` once the match concludes.

### Match finalization is atomic and idempotent

The match row, both participant snapshots, and both rating rows are written in a
single Prisma transaction — they all change or none do. Idempotency comes from a
conditional `status: "ACTIVE"` update: only the caller that actually flips the
match out of ACTIVE applies the rating change, so a duplicate or concurrent
finalize replays the stored outcome instead of awarding the delta twice.

Clients are told the outcome *only after* persistence succeeds. If it fails, the
result message carries `persisted: false` and the UI says so rather than
displaying a rating change that never happened.

### REST and realtime run on separate ports

`PORT` (4000, Fastify) and `COLYSEUS_PORT` (4001). Colyseus 0.18's `Server`
installs its own HTTP handler on whatever `http.Server` its transport is bound
to — unconditionally, not only when its Express integration is used — and it
collides with any other framework on the same server, crashing the process with
`ERR_HTTP_HEADERS_SENT` as soon as a request hits a route only one of them
knows. Separate ports sidestep it and are a normal split anyway, since an API
and a realtime gateway scale differently.

### Dependency quirks worth knowing

- **`express` is a real dependency of `apps/server`** even though the API is
  Fastify. `@colyseus/ws-transport` statically imports it at module load, so the
  process won't boot without it — despite us never calling that code path.
- **`@prisma/adapter-pg` is required.** Prisma 7's `prisma-client` generator
  needs a driver adapter to reach Postgres.
- **Clerk Core 3 removed `<SignedIn>` / `<SignedOut>` / `<Protect>`**, replaced
  by `<Show when="signed-in">`. `createRouteMatcher` is deprecated in favor of
  per-page checks, so `proxy.ts` runs `clerkMiddleware()` for session context
  only — the real authorization boundary is the server verifying the token on
  every REST and WebSocket call.
- **Next 16 removed `next lint`.** Linting is ESLint flat config
  (`apps/web/eslint.config.mjs`), run as `pnpm lint`.

## Monorepo layout

```
apps/
  server/           Fastify REST API + Colyseus realtime server + Prisma
  web/              Next.js frontend (lobby, live match UI)
packages/
  shared-types/     GameEngine contract + domain types shared by server & web
  game-engines/     Game plugins (Wordle first) implementing GameEngine
  rating-glicko2/   Glicko-2 rating algorithm, game-agnostic
```

## Local development

Requires Postgres and Redis. `docker-compose.yml` starts both
(`docker compose up -d`); without Docker, native installs work identically
(`brew install postgresql@14 redis` on macOS) — just point `DATABASE_URL` /
`REDIS_URL` at wherever they run.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env    # fill in real Clerk keys
cp apps/web/.env.example apps/web/.env.local    # same Clerk application
pnpm --filter @smart-rot/server db:migrate      # applies migrations + generates the Prisma client
pnpm --filter @smart-rot/server dev             # REST :4000, Colyseus WS :4001
pnpm --filter @smart-rot/web dev                # http://localhost:3000
```

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
```

`pnpm test` runs 28 tests: Wordle engine and Glicko-2 unit tests (no
infrastructure needed), plus the server suites, which need **Postgres and Redis
running** — they exercise the real database and matchmaker rather than mocks.

Server tests fake Clerk at the `clerkAuth` seam (`apps/server/src/auth/clerk.ts`),
treating the supplied token as the Clerk subject, so no live Clerk credentials
are needed. Everything downstream of that — JIT provisioning, rating rows, room
authorization, persistence — is the real code path. Each suite namespaces its
users by prefix (`it-`, `api-`) so concurrent files never contend on the same
rows, and cleans them up afterwards.

Covered: Clerk-subject → internal-id mapping, distinct-user matchmaking, move
rejection before both players are ready, state privacy between players, solving
to a win, exactly-once rating updates, finalization idempotency, forfeit on
leave, reconnect within the grace period, no-show abort with no rating change,
one-session-per-game enforcement, REST authorization, and the CORS contract.

### Verification status

Automated tests and all four gates pass end to end against real Postgres and
Redis. **Not yet verified: a live run with two real Clerk accounts in two
browsers.** That path — real Clerk tokens, the Next.js UI, and the browser's own
CORS enforcement — is the one thing the fake-auth seam cannot prove, and it
needs Clerk API keys this repo doesn't ship. To do it: fill in real keys in both
`.env` files, run both dev servers, sign in as two different users, and confirm
queue → match → result → rating/history update, plus a mid-match refresh
resuming rather than forfeiting.

## Explicit non-goals for this phase

- No real-money wagering, token purchases, or withdrawals — deliberately
  deferred, with its own legal/compliance review.
- No building every game at once; Phase 1 proves the shared architecture first.
- No elaborate bot AI; a simple, clearly-parameterized bot beats a clever one.
