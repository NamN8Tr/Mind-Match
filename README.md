# Smart Rot — Ranked Multiplayer Puzzle Platform

Head-to-head ranked puzzle games, chess.com-style: lobby, matchmaking, per-mode
Glicko-2 ratings, match history, profiles, and solo timed personal-best runs.
Wordle and Spider Solitaire are playable today; Sudoku and Minesweeper are next.
No real-money features in this phase.

For the full project history, implementation rationale, verified state, fixed
test-account policy, and continuation plan, read
[`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md) first.

## Status

**Wordle (Phase 1 vertical slice) and Spider Solitaire are implemented and
covered by automated tests; Wordle also passed a live two-account
backend/realtime smoke test. The release gate still requires a visual
two-browser UI pass.**

- [x] Monorepo scaffold (pnpm workspaces + Turborepo)
- [x] `GameEngine` contract + shared domain types (`packages/shared-types`)
- [x] Wordle engine plugin — deterministic seeded puzzle, Speed + Fewest Guesses
- [x] Spider Solitaire engine plugin — 1/2/3/4-suit modes, take back, reset, provably solvable deals
- [x] Solver-certified Spider board supply — C++ worker, persistent Postgres pool, bundled fallback boards
- [x] Glicko-2 rating engine — verified against the worked example in Glickman's paper
- [x] Postgres schema (users, per-game-mode ratings, match history, timed personal bests, Spider board pool) + migrations
- [x] Clerk auth with JIT user provisioning; editable profiles and match-history REST API with CORS
- [x] Matchmaking (expanding rating window), generic game-room factory, Wordle and Spider rooms
- [x] Match lifecycle: join deadline, synchronized ready countdown, reconnect grace, wall-clock or idle timeout, stale-match reaper
- [x] Atomic + idempotent match finalization
- [x] Web app: game catalog, editable/public player profiles, opponent identity/rating, ranked modes, Wordle Speed Solo, Spider solo, achievements, Spider hints and auto-move, refresh-safe reconnect
- [x] 73 automated tests: 28 server (17 realtime integration, 9 REST, 2 Spider board pool), 31 game-engine, 6 Glicko-2, 8 web
- [x] Live Clerk smoke with two fixed reusable test users (auth, queue, play, reconnect, ratings, history) — Wordle path
- [ ] Visual two-browser UI smoke (see "Verification status")
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
player** — a Wordle race exposes your opponent's letterless color feedback but
never their guessed words. Colyseus's `@colyseus/schema` sync broadcasts one shared state to
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

Handled generically in `createGameRoom` so every game inherits it. Where a game
needs different rules, it opts in through `GameRoomOptions` (Spider's rows below)
rather than adding game-specific branches to the room:

| Situation | Behavior |
| --- | --- |
| Both players `ready` | Server broadcasts a synchronized 3–2–1 countdown |
| Countdown ends | Match starts; moves are accepted; timeout clock starts |
| Move before start or during countdown | Rejected with a reason, never silently dropped |
| Nobody joins within 30s | Aborted, **no rating change** |
| Connection drops | 20s reconnect grace; resuming restores full state |
| Grace expires (Wordle) | Forfeit to the opponent |
| Wordle Speed deadline expires with no solve | Draw |
| Wordle Fewest Guesses deadline expires | The only/lower-guess solver wins; otherwise draw |
| Spider: one player leaves | Not a forfeit — the other keeps playing the same board (`departurePolicy: "continue-until-both-leave"`) |
| Spider: both players leave | Draw |
| Spider: 10 minutes with no move from either player | Draw. Spider uses an idle timeout (`idleTimeoutMs`) instead of a wall-clock cap, so a long game is never cut off mid-play |
| Spider: first player to clear all eight runs | Wins; the solve time also counts toward that mode's personal best |
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

Ratings are keyed by `(userId, gameId, mode)`. Each mode is its own pool:
Wordle Speed and Fewest Guesses, and Spider 1/2/3/4-suit. Matchmaking reads and
finalization updates only the selected mode's pool. Every pool begins at 400,
and the lobbies show each value on its corresponding mode card. The per-game
Redis session lock is shared across modes, so one account cannot enter two
Wordle (or two Spider) queues simultaneously. `gameId` and `mode` are plain
strings, so a new mode needs no migration, but it must be added to
`SUPPORTED_RATING_POOLS` in `apps/server/src/routes/api.ts` so `/api/me`
provisions its rating row.

New ratings begin with deviation 100. The opponent's rating and deviation feed
Glicko-2's expected-score calculation, so movement is not a fixed amount: at
the initial 400 rating, beating a 250 / 400 / 550 opponent currently awards
about 16 / 26 / 36 points respectively. Losses mirror that relationship.

Clients are told the outcome *only after* persistence succeeds. If it fails, the
result message carries `persisted: false` and the UI says so rather than
displaying a rating change that never happened.

### Profiles, opponent identity, and solo runs

The top-right avatar uses Clerk's original account popover. Manage account opens
one modal with only Profile and Achievements navigation. Profile is assembled
from Clerk's original account sections, with its original username, email,
phone, connected-account, password, and account-deletion controls; password and
deletion live on Profile instead of a separate Security tab. Clerk username
changes are synchronized to the application's internal `User.displayName`, so
the same username appears to opponents. Achievements lists every ranked and
timed mode with the player's ranked wins and, for timed modes, their best time
(a dash until one is set). Account deletion also removes the corresponding Smart
Rot profile, ratings, personal bests, and match participation. Ranked rooms
privately send each player the opponent's display name and pre-match rating for
the selected mode. This metadata is never trusted from the browser and does not
expose the opponent's guessed letters or Spider cards.

Wordle Speed Solo and Spider solo (one room per suit mode) use their own
authenticated, single-player Colyseus rooms. The server owns the countdown,
puzzle or deal, move validation, and elapsed time. A successful run atomically
creates or improves the user's personal best for that mode; slower, failed, and
abandoned runs cannot overwrite it. Spider solo has no length cap, only a
10-minute idle timeout. Solo runs deliberately create no ranked match-history row
and never change a rating.

Spider originally shipped with a single mode stored as `speed`. Those legacy
rating and personal-best rows are the 1-suit pool, and the web client folds them
in via `isSameMode()` in `apps/web/lib/achievements.ts`.

Signed-in players can open `/players/:userId` from an opponent name to see that
player's ratings, solo personal bests, ranked record, and recent completed
matches. The backing endpoint intentionally omits Clerk identifiers and active
matches. Live-match profile links open a new tab so viewing one does not forfeit
the current game.

### Spider deals are certified solvable ahead of time

Every Spider deal a player sees comes with a stored winning move sequence. Room
creation can't wait on a search, because `GameEngine.generateInitialState` is
synchronous and searches for a 4-suit solution can take minutes. So the boards
are produced ahead of time and consumed later:

1. **Background refill.** At boot the server starts `SpiderBoardPool`
   (`apps/server/src/spider-board-pool/service.ts`). While any mode is below its
   target inventory (10 / 10 / 20 / 30 boards for 1–4 suits), it runs the
   dependency-free C++17 worker in `tools/spider-solver` on a random seed with a
   per-mode time and state budget. A Redis lock keeps a mode's refill to one
   process at a time.
2. **Untrusted until replayed.** Solver output is never trusted. Every solution
   is replayed move by move through the authoritative TypeScript engine
   (`verifySpiderDeal`). Deals that are too easy for their mode, measured by
   states searched and solution length, are discarded. Survivors go into the
   `spider_boards` table.
3. **Claim at room creation.** A room's `prepareSeed` hook claims the oldest
   stored board for its mode with a serializable delete. It then pins that board
   to the room seed (`registerSpiderDealAssignment`) before the engine builds
   state, so both ranked players get the identical deal.
4. **Fallback.** If the pool is empty or the solver binary is missing, the
   engine serves `packages/game-engines/src/spider/verified-board-pool.json`.
   These bundled verified boards are dealt with a seeded column and suit
   permutation that keeps their saved solution valid. The server logs a warning
   and keeps running.

The worker is an independent implementation; see
[`tools/spider-solver/NOTICE.md`](tools/spider-solver/NOTICE.md) for provenance.

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
- **`apps/web/next-env.d.ts` is generated, not tracked.** `next dev` and
  `next build`/`next typegen` write different variants of it, so it is
  gitignored (as the Next 16 docs recommend). The web `typecheck` script runs
  `next typegen` first so a fresh clone typechecks.
- **The Spider worker needs a C++17 compiler** (`c++`, e.g. Xcode Command Line
  Tools). `pnpm build` and `scripts/dev.sh` compile it into the gitignored
  `tools/spider-solver/bin/`. Without it the server still runs on the bundled
  boards.

## Monorepo layout

```
apps/
  server/           Fastify REST API + Colyseus realtime server + Prisma + Spider board pool
  web/              Next.js frontend (catalog, lobbies, live match and solo UI)
packages/
  shared-types/     GameEngine contract + domain types shared by server & web
  game-engines/     Game plugins (Wordle, Spider) implementing GameEngine
  rating-glicko2/   Glicko-2 rating algorithm, game-agnostic
tools/
  spider-solver/    C++17 Spider search worker that certifies solvable deals
```

## Local development

One command brings the whole stack up:

```bash
pnpm launch          # or ./scripts/dev.sh
```

It checks the toolchain, builds the Spider solver worker, creates the two `.env`
files from their examples if they're missing, makes sure Postgres and Redis are
reachable (starting them via `docker compose` or `brew services` if they
aren't), installs dependencies, applies migrations, generates the Prisma client,
then runs both dev servers in one terminal with tagged output. Ctrl-C stops
everything it started.

Clerk keys are the one thing it can't supply — a freshly created `.env` carries
the placeholders from `.env.example`, and the script says so. Fill in real keys
from the same Clerk application in both files before signing in.

```bash
./scripts/dev.sh --restart        # take over ports 3000/4000/4001 if already held
./scripts/dev.sh --skip-migrate   # leave the database schema alone
./scripts/dev.sh --skip-install   # skip pnpm install
./scripts/dev.sh --server-only    # backend only
./scripts/dev.sh --web-only       # frontend only
./scripts/dev.sh --help
```

`PORT`, `COLYSEUS_PORT`, and `WEB_PORT` in the environment override
`apps/server/.env`, which is how you run a second stack alongside a running one.

<details>
<summary>Doing it by hand</summary>

Requires Postgres and Redis. `docker-compose.yml` starts both
(`docker compose up -d`); without Docker, native installs work identically
(`brew install postgresql@14 redis` on macOS) — just point `DATABASE_URL` /
`REDIS_URL` at wherever they run.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env    # fill in real Clerk keys
cp apps/web/.env.example apps/web/.env.local    # same Clerk application
pnpm build:spider-solver                        # optional: lets the server refill the Spider board pool
pnpm --filter @smart-rot/server db:migrate      # applies migrations + generates the Prisma client
pnpm --filter @smart-rot/server dev             # REST :4000, Colyseus WS :4001
pnpm --filter @smart-rot/web dev                # http://localhost:3000
```

</details>

## Testing

```bash
pnpm typecheck && pnpm lint && pnpm test && pnpm build
pnpm --filter @smart-rot/server smoke:live
```

`pnpm test` runs 73 tests. The game-engine (Wordle, Spider), Glicko-2, and web
(Spider hint/auto-move) unit tests need no infrastructure. The server suites
need **Postgres and Redis running**, because they exercise the real database
and matchmaker rather than mocks. Turbo caches test results; use
`pnpm test --force` for a genuine rerun.

To run one file or one test, call `tsx --test` inside the package:

```bash
pnpm --filter @smart-rot/game-engines exec tsx --test src/spider/engine.test.ts
pnpm --filter @smart-rot/server exec tsx --test --test-timeout=25000 --test-name-pattern="Spider" src/integration.test.ts
```

Server tests fake Clerk at the `clerkAuth` seam (`apps/server/src/auth/clerk.ts`),
treating the supplied token as the Clerk subject, so no live Clerk credentials
are needed. Everything downstream of that — JIT provisioning, rating rows, room
authorization, persistence — is the real code path. Each suite namespaces its
users by prefix (`it-`, `api-`) so concurrent files never contend on the same
rows, and cleans them up afterwards.

Covered: Clerk-subject → internal-id mapping, distinct-user matchmaking, move
rejection before both players are ready and during the server countdown, state
privacy between players, color-only opponent progress, solving
to a win, exactly-once rating updates, finalization idempotency, forfeit on
leave, reconnect within the grace period, forfeit after grace expiry,
timer-driven no-show abort with no rating change, persisted match-timeout draw,
final-answer reveal after an external timeout, one-session-per-game
enforcement across modes, Speed's authoritative clock, Fewest Guesses waiting
for both players and awarding the lower guess count, independent rating pools,
opponent-sensitive rating movement, mode persistence, REST authorization,
username validation and persistence, opponent name/rating delivery, solo server
timing, personal-best persistence, and the CORS contract.
Public-profile authorization, not-found behavior, safe field selection, record
aggregation, completed-match history, and authenticated profile deletion are
covered as well.

Spider coverage:
- **Engine:** deterministic shared deals; all four suit counts; full-deck shape.
  Every generated deal carries a legal solution, and the verifier rejects
  corrupted solutions and malformed decks. Also covered: stack and suit move
  rules, draw with empty columns, take back, reset, and opponent-view privacy.
- **Server:** both ranked players get the same solvable board; one departure is
  not a forfeit; both leaving records a draw; a stored pool board is claimed and
  pinned to its room seed.
- **Web:** auto-move destination priority, hint ordering, and hint cycling.

`smoke:live` crosses the boundary the ordinary suite intentionally fakes: it
uses two real Clerk development users and genuine Clerk session JWTs against
the running Fastify and Colyseus services. It reuses the same two
`+clerk_test` addresses on every run, revokes only its temporary sessions, and
never deletes or replaces the users. See the exact account policy and runbook
in [`docs/PROJECT_CONTEXT.md`](docs/PROJECT_CONTEXT.md#fixed-clerk-test-account-policy).

### Verification status

Automated tests and all four gates pass end to end against real Postgres and
Redis. On August 27, 2026, the live smoke also passed with real Clerk JWTs:
authenticated REST + CORS, distinct-user matchmaking, gameplay, a mid-match
disconnect/reconnect with state recovery, atomic rating updates, and match
history were all verified. That smoke drives Wordle only. Spider's ranked and
solo paths are covered by the automated suite, with no live-smoke run recorded.

**Not yet verified: the rendered Next.js/Clerk experience in two actual browser
sessions.** The coding runtime had no attached browser backend, so the remaining
manual pass is limited to sign-in components, client navigation, browser-native
CORS behavior, responsive UI, profile editing, solo play, and refresh UX. Run both dev servers, sign in as
the two fixed test users from the context document, and confirm queue → canonical
match URL → refresh/reconnect → result → rating/history in both sessions.

## Explicit non-goals for this phase

- No real-money wagering, token purchases, or withdrawals — deliberately
  deferred, with its own legal/compliance review.
- No building every game at once; each new game should be an engine plus
  registration and UI, reusing matchmaking, lifecycle, finalization, and ratings
  unchanged.
- No elaborate bot AI; a simple, clearly-parameterized bot beats a clever one.
