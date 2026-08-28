# Smart Rot project context and handoff

Last updated: August 27, 2026

Read this file before making changes. It records the product intent, what has
already been built, why several non-obvious architecture choices exist, how the
current system was verified, and what remains. It is intended to give Claude,
Codex, or a human contributor enough context to continue without repeating the
same investigation.

## Product intent

Smart Rot is a ranked, head-to-head puzzle platform modeled on the product loop
of chess sites: authenticate, enter a game-specific matchmaking queue, play a
short server-authoritative match, receive a per-game-mode rating update, and review
match history. Wordle is the proving vertical slice. The planned order after it
is Sudoku, Minesweeper, bots, then Spider Solitaire and additional games.

The durable product rules from the original brief are:

- The server, never the client, validates moves and decides outcomes.
- Games are plugins behind one `GameEngine<State, Move>` contract.
- Ranked opponents receive the same seeded puzzle or board.
- Each game mode has an independent Glicko-2 rating pool.
- Future bots submit moves through the same validated path as people.
- No wagering, wallets, token purchases, withdrawals, or other real-money
  features belong in the current scope.
- Do not start multiple games in parallel. Prove the Wordle slice first.

## Decisions already made

| Area | Choice | Reason |
| --- | --- | --- |
| Workspace | pnpm workspaces + Turborepo | Shared TypeScript packages and one set of root quality gates |
| Web | Next.js 16 + React + Clerk | App Router UI with managed authentication |
| API | Fastify | Small typed REST surface for profile and match history |
| Realtime | Colyseus 0.18 | Room lifecycle, seat reservations, and reconnection fit ranked game sessions |
| Durable data | PostgreSQL + Prisma 7 | Users, ratings, match results, and participant snapshots |
| Ephemeral coordination | Redis | Queue/match session locks and Colyseus presence/driver state |
| Rating | Glicko-2, displayed starting rating 400 and deviation 100 | Per-mode, opponent-sensitive rating movement on a beginner-friendly scale |
| First game | Competitive Wordle race | Cheapest end-to-end proof of the shared platform |

Do not replace these foundations casually. A new game should normally be a new
engine plus registration and UI, not a rewrite of authentication, matchmaking,
ratings, or match orchestration.

## Chronological history

### 1. Original scaffold — commit `02d5ab1`

The first implementation established the monorepo and the complete shape of a
Wordle vertical slice:

- `packages/shared-types`: game contract and shared domain types.
- `packages/game-engines`: deterministic seeded Wordle engine and word lists.
- `packages/rating-glicko2`: game-agnostic Glicko-2 implementation.
- `apps/server`: Clerk verification, Prisma schema, Fastify endpoints,
  Colyseus matchmaking/game rooms, and Redis integration.
- `apps/web`: Clerk UI, lobby, Wordle board, match flow, and history.
- Postgres/Redis local development support and root build/test/typecheck tasks.

The pure packages had 14 passing tests, but the initial server suite contained
no tests. Static builds passed without proving the two-user integration path.

### 2. Integration review

A code review of the running project found issues that a package build could
not expose:

1. Matchmaking treated a Clerk subject as a Prisma `User.id`, which would fail
   when rating rows referenced the wrong id namespace.
2. The browser called the Fastify port cross-origin without an explicit CORS
   policy.
3. A match could accept play too early, a refresh could become an immediate
   forfeit, and abandoned rooms could remain active.
4. Rating and result persistence did not have a single atomic/idempotent
   finalization boundary.
5. The canonical match URL and refresh/reconnection path were disconnected
   from normal matchmaking.
6. The risky paths had no server integration tests, and Next 16 no longer
   supported the old `next lint` command.

### 3. Reliability repair — commit `5b9d04a`

The Wordle slice was repaired without changing the chosen architecture:

- Centralized Clerk-token verification plus just-in-time mapping to the
  internal Prisma user.
- Added explicit `WEB_ORIGIN` CORS configuration.
- Added a client-driven `ready` handshake so opening state cannot race client
  listener setup.
- Added a join deadline, 20-second reconnect grace, match timeout, explicit
  terminal disposal, and stale-active-match cleanup at boot.
- Added a Redis lock preventing the same internal user from holding multiple
  queue/match sessions for one game.
- Made match finalization atomic and idempotent, including both participant
  snapshots and both rating updates.
- Made `/match/[roomId]` canonical and persisted the reconnection token in
  session storage for refresh recovery.
- Added ESLint flat config and 14 server tests. The repository now has 28 tests
  total: 14 server tests plus 14 package unit tests.

### 4. Clerk setup and live verification — August 27, 2026

A Clerk development application was configured in the ignored local env files:

- `apps/server/.env`
- `apps/web/.env.local`

Never copy their values into documentation, source, logs, commits, or chat.

The available coding runtime had no attached interactive browser backend. The
remaining work therefore continued without browser control. A backend-driven
live smoke test was added at
`apps/server/src/scripts/live-clerk-smoke.ts`. It uses Clerk's real Backend API,
real Clerk session JWTs, the running Fastify API, the running Colyseus gateway,
Postgres, and Redis.

The first request exposed that the already-running API process had loaded the
old environment before the Clerk keys were entered. Only the server watcher was
restarted; the web dev process was left alone. The rerun then passed the full
live path:

1. Reuse or create the two fixed Clerk development test users.
2. Create short-lived Clerk sessions and obtain genuine session JWTs.
3. Call `/api/me` through real token verification and JIT user provisioning.
4. Assert the configured CORS response header.
5. Queue two distinct users and consume the same match-room reservation.
6. Ready both clients and play a valid wrong Wordle guess.
7. Drop and reconnect the winning client using its reconnection token.
8. Confirm the earlier guess survives reconnection.
9. Solve the shared seeded puzzle.
10. Assert both clients receive the same persisted result.
11. Assert the winner rating rises and the opponent rating falls.
12. Confirm both `/api/me` and `/api/matches` expose the persisted update.
13. Revoke only the temporary Clerk sessions; retain the two user records.

Verified live match id from that run: `cmtc08gac00046rnb1xb7skh5`.

A second live run was then used to prove account idempotency. It reported both
fixed users as reused, created no additional user, and completed match
`cmtc0buvb00076rnb7nnb57e1` through the same flow.

After the lifecycle-contract and final-state changes, a third regression run
again reused both users and passed through match
`cmtc1sm690000j0nbi4lwwja9`.

### 5. Test-process isolation found during the final gate

The final forced, uncached suite was initially run while the normal dev gateway
was still active. Four realtime cases intermittently failed with `seat
reservation expired`. Both processes had registered the same room names through
the same Redis-backed Colyseus driver, so either process could claim a test room
even though the test client was connected to a random local test port.

`createColyseusServer({ isolated: true })` now gives integration tests
process-local Colyseus presence and room discovery. The production/default path
still uses Redis. Redis remains real in the tests for the application's own
session-lock behavior. The forced suite was rerun with the dev gateway still
running and all 28 tests passed.

### 6. Lifecycle acceptance coverage completed

The original execution plan required three timer paths that the first 28 tests
did not exercise directly: the join deadline firing on its own, a dropped
client exhausting the reconnect grace period, and the match deadline producing
a draw. Room timings can now be injected into an integration-only server while
the production defaults remain 30 seconds, 20 seconds, and 5 minutes.

Three realtime tests now prove:

- the join timer records `ABORTED/no-show` and leaves both ratings unchanged;
- a missed reconnect grace period records one `opponent-left` forfeit and a
  duplicate terminal trigger cannot apply ratings twice;
- the match timer records a persisted `draw/timeout` for both clients.

That work exposed one presentation defect: a timeout or forfeit ends the match
in orchestration while the puzzle engine's state remains non-terminal, so the
old final state view kept Wordle's answer hidden. `GameEngine` serialization now
accepts an optional final `MatchResult`; Wordle uses it to reveal the answer for
all externally terminated matches without adding Wordle-specific logic to the
generic room. The repository now has 32 tests: 17 server tests and 15 package
unit tests.

### 7. Frontend lifecycle hardening

A static pass against the remaining frontend requirements found cleanup paths
that did not need a browser to verify structurally:

- A failed seat-reservation consumption now removes queue listeners, leaves the
  queue, and promptly releases the Redis session lock instead of returning the
  UI to idle while the queue remained alive.
- Queue message/error/leave listeners are detached on handoff, cancellation,
  errors, and component unmount. Unexpected queue closure is shown to the user.
- Duplicate `seat` messages cannot start two concurrent reservation consumers.
- Match connection-loss UI now reacts to Colyseus `onDrop` immediately and
  clears on `onReconnect`, which repeats the `ready` snapshot handshake.
- A failed stored-token reconnect clears the stale token before a fresh join.
- Profile loading and room connection are handled with `Promise.allSettled`, so
  a profile failure cannot strand a successfully connected room.

These changes follow the installed Next 16 App Router navigation guidance and
retain programmatic `router.push()` for the post-matchmaking handoff. They pass
the web typecheck, ESLint, and production build. Interactive behavior remains
part of the outstanding two-browser visual release gate below.

### 8. Stale Next development manifest recovery

The first manual browser attempt hit a React Client Manifest error for Clerk's
`ClientClerkProvider`. The generated `.next/dev` cache contained Clerk module
references from two different pnpm peer-dependency paths, while the current
`node_modules/@clerk/nextjs` symlink pointed to only the newer path. This can
happen when a Next dev process remains alive across dependency/peer-graph
changes.

Only the web dev process was stopped. Its generated `.next/dev` directory was
moved to a temporary backup, Next was restarted, and `/` then rendered with HTTP
200 without the manifest error. No source, environment file, database data, or
Clerk account was removed.

If the same manifest/module-path error returns after `pnpm install` or a lockfile
change, restart the web dev server and clear or move `apps/web/.next/dev` before
debugging application code. Next 16 already keeps development output under that
subdirectory; the production build output does not need to be discarded.

### 9. First two-session browser pass and refresh repair

The first human two-window pass proved that two distinct Clerk users could enter
the same match and that the completed outcome appeared in rating and match
history. Refreshing one active match page incorrectly awarded the other player
an immediate win, and the refreshed page then reported that the room was not
found.

The server's disconnect behavior was correct: a dropped socket enters the
20-second reconnection grace path, while a consented `room.leave()` forfeits
immediately. The fault was in the match page's connection effect. Next App
Router enables React Strict Mode in development, which replays effect setup and
cleanup. Two connection attempts raced for one reconnection token, and the
discarded attempt called consented `leave()`, turning React's diagnostic cleanup
into a real forfeit.

`/match/[roomId]` now keeps one shared in-flight connection promise per mounted
page. The replayed effect setup adopts that same promise, and a deferred cleanup
is canceled by the immediate replacement setup. A genuine client-side
navigation still leaves deliberately; a document refresh drops naturally so
Colyseus can hold and reconnect the seat. The backend reconnect integration
test remains green. A follow-up human two-window retest confirmed that refreshing
no longer awards the opponent an instant win. The final browser acceptance step
is to confirm that the refreshed player sees the resumed board and can finish
that same match.

### 10. Beginner-scale starting rating

Per-game-mode ratings now use a 400 starting point instead of 1500. The shared
Glicko-2 constant, Prisma schema default, migration, and REST test all use the
same source of truth. Migration `20260827230000_lower_initial_rating` changes
the column default. Migration `20260827231000_rebase_existing_ratings` then
translates every existing current rating and historical before/after snapshot
by -1100. This is not a competitive reset: relative ranks and every recorded
match delta stay identical, while established users and new users remain in one
compatible pool. Both migrations were applied to the local development
database and all rating reference tests still pass.

### 11. Wordle-style direct board input

The separate guess text box and Guess button were removed from the match UI.
Physical letter keys now fill the active board row directly; Enter submits and
Backspace/Delete removes the last letter. A responsive on-screen QWERTY keyboard
provides the same controls for pointer and touch users, and submitted letters
inherit the strongest known absent/present/correct feedback across guesses.

The server remains authoritative: the client only builds a pending word and
sends the existing `WordleMove` on Enter. Invalid words stay in the row so the
player can edit them. Because every accepted move broadcasts a private snapshot
to both players, the client tracks its own submitted-guess count and clears the
pending row only when that count advances; an opponent move cannot erase a word
currently being typed. Web typecheck, ESLint, and the Next production build pass
after this change. A human interaction/layout pass is still appropriate.

### 12. Game catalog and two Wordle modes

The root route is now a game catalog rather than the Wordle lobby. Wordle is the
enabled game card at `/games/wordle`; Sudoku and Minesweeper are visible as
coming-soon cards so the navigation already reflects the multi-game product.
The Wordle route owns its two independent ratings, combined history, and two mode cards:

- `speed`: first correct solve wins, with a visible five-minute match timer;
- `fewest-guesses`: both players finish, and the lower successful guess count
  wins. Equal successful counts draw. If the deadline arrives with only one
  solver, that solver wins.

The modes have distinct Colyseus matchmaking, match rooms, and Glicko-2 pools,
so incompatible rulesets can never be paired or rated together. The per-game
Redis lock still prevents one user from queueing in both modes at once. Every
match persists `mode`; migration
`20260828010000_add_match_mode` labels all pre-mode history `speed`, matching
the original first-solve-wins behavior.

After both players complete the `ready` handshake and the ready-up countdown
ends, the room broadcasts `startedAt`, `deadlineAt`, and `serverNow`. The Speed
UI derives its match timer from that authoritative clock and re-receives it
after reconnection, so refresh does not reset the timer. `GameEngine.getTimeoutResult()` is an optional generic hook
that lets Fewest Guesses award an existing solver at the room deadline while
other games retain the default timeout draw.

Three engine tests and two real two-client integration tests cover the new
rules, including a later one-guess solver beating the first two-guess solver.
The mode migration was applied locally; typecheck, ESLint, tests, and both production
builds pass.

### 13. Opponent color board and ready-up countdown

The old opponent guess dots were replaced by a compact letterless Wordle board
beside the player's board. Each accepted opponent guess reveals only its five
`correct` / `present` / `absent` states. `WordleOpponentView.feedback` is an
array of color-state rows; it never includes the guessed strings. The board
stacks below the main board on narrow screens.

Rooms now move through `waiting` → `countdown` → `active`. Once both clients are
ready, the server broadcasts a three-second countdown using `endsAt` and
`serverNow`. Moves remain rejected throughout this phase, and the five-minute
match deadline starts only when the countdown ends. A client reconnecting during
the ready-up phase receives the original countdown deadline rather than starting
a new one.

Engine and two-client integration assertions cover color feedback privacy, the
countdown duration, delayed match-clock start, and rejection of countdown moves.
The full repository now has 39 tests: 20 server tests and 19 package tests. The
mode migration was applied locally; typecheck, ESLint, tests, and both production
builds pass.

### 14. Independent ratings for each mode

Ratings are keyed by `(userId, gameId, mode)`. `/api/me` creates and returns a
Speed rating and a Fewest Guesses rating, each beginning at 400, and the lobby
shows the relevant value directly on each mode card. Matchmaking ranks players
using only the selected mode's pool. Finalization reads the persisted match mode
and updates only that same pool, while match history continues using the rating
snapshots recorded on each participation.

Migration `20260828020000_split_ratings_by_mode` assigns existing local test
ratings to `speed`; `fewest-guesses` rows start fresh when first requested. The
integration suite verifies that completing a Speed match leaves both players'
Fewest Guesses ratings byte-for-byte unchanged.

### 15. Calmer, opponent-sensitive rating movement

The displayed starting point had moved from 1500 to 400, but the initial rating
deviation was still 350. That high uncertainty—not a hard-coded match delta—was
why early results could move roughly 120–160 points. Initial deviation is now
100. At a new 400 rating, the current Glicko-2 calculation awards approximately
16 points for beating a 250 opponent, 26 for beating a 400 opponent, and 36 for
beating a 550 opponent. Losing follows the inverse pattern: a weaker-opponent
loss costs more, while a stronger-opponent loss costs less.

Migration `20260828021000_lower_initial_rating_deviation` changes the database
default and resets the current local test pools to deviation 100. A regression
test locks in both moderate equal-player movement and the stronger/equal/weaker
opponent ordering.

## Fixed Clerk test-account policy

Use only these two persistent test identities for this project:

| Slot | Email | Intended display name |
| --- | --- | --- |
| Player one | `smartrot-player-one+clerk_test@example.com` | Smart Rot One |
| Player two | `smartrot-player-two+clerk_test@example.com` | Smart Rot Two |

Rules:

- Do not create a new Clerk user for every test run.
- The live smoke command looks up each exact address first and creates only a
  missing one. If duplicates exist, it fails instead of silently adding more.
- Do not delete these users during normal cleanup; reuse them.
- The script creates short-lived sessions and revokes those sessions in a
  `finally` block. It never prints JWTs, keys, or passwords.
- It makes the lower-rated account win each run, which keeps the pair close
  enough for fast matchmaking instead of pushing their ratings farther apart.
- Clerk reserves addresses containing `+clerk_test` for development testing.
  If the browser sign-in flow uses an email verification code, the documented
  test code is `424242` and no real email is sent. See
  <https://clerk.com/docs/guides/development/testing/test-emails-and-phones>.
- Test-email behavior avoids delivery/quota churn; this document does not make
  broader billing guarantees. Keeping exactly two reusable records also avoids
  unnecessary account sprawl.
- Create a replacement only if one of these two records was deliberately
  removed from the current Clerk development instance.

Run the live check with:

```bash
pnpm --filter @smart-rot/server smoke:live
```

It requires Postgres, Redis, the Fastify server on port 4000, the Colyseus
gateway on port 4001, and valid Clerk values in `apps/server/.env`.

## Architecture invariants

### External identity is not an internal player id

A Clerk JWT's `sub` claim belongs to Clerk. `User.id` belongs to this database.
Every authenticated REST and realtime entry point must call
`resolveAuthenticatedUser()` and carry the resulting internal id from then on.
Use `User.authSubject` only for the Clerk mapping.

### The server is authoritative

Clients submit `move` intents. A `GameEngine` validates and applies them. The
client must never choose the answer, decide a win, update a rating, or provide a
trusted elapsed time.

### State is private per player

The room sends `serializeStateForPlayer()` results directly to each client.
Wordle exposes letterless opponent color feedback but not guessed words. Do not
replace this with a single broadcast schema unless the privacy model is preserved.

### `ready` is part of the protocol

The server intentionally sends no state from `onJoin`. A client attaches
`phase`, `countdown`, `clock`, `state`, `result`, and rejection listeners, then
sends `ready`. Both players must be ready and the synchronized three-second
countdown must finish before moves or the match timer begin. A reconnected
client repeats this handshake to request a fresh private snapshot and the
current authoritative countdown or match deadline.

### Match finalization has one transaction boundary

Status/result, final game state, both participant snapshots, and both rating
updates must commit together. The conditional ACTIVE-to-terminal transition is
the exactly-once claim. Do not update ratings elsewhere or broadcast a
persisted result before this completes.

### REST and realtime use separate ports

Fastify uses 4000 and Colyseus uses 4001. Colyseus 0.18 installs its own HTTP
handling on its transport server and collided with Fastify when both shared one
server. Keep the split unless the underlying library behavior changes and is
verified.

### Redis session-lock ownership follows the handoff

Matchmaking owns and releases a lock until a group is successfully handed to a
match. The match owns it after that and `finalizeMatch()` releases it. Preserve
that ownership transition so an error cannot leave permanent duplicate-session
blocks.

## Current verification matrix

| Surface | Status | Evidence |
| --- | --- | --- |
| Wordle modes, rules, and privacy serialization | Passing | 13 package tests |
| Glicko-2 calculation | Passing | 6 package tests, including the canonical worked example and opponent-strength ordering |
| REST auth, identity mapping, history, CORS | Passing | 6 server tests |
| Matchmaking/modes/countdown/clock/lifecycle/reconnect/finalization | Passing | 14 two-client server integration tests |
| Live Clerk JWT + local REST/realtime + persistence | Passing | `smoke:live` run on August 27, 2026 |
| Typecheck, ESLint, production builds | Passing with the live smoke and test-isolation changes included | Root commands below |
| Next.js + Clerk rendered UI in two browser sessions | Partially verified | Same-room play, persistence, and no instant refresh-forfeit verified; resumed-board completion remains |

The live smoke is stronger than a mocked-auth test for the backend seams, but it
does not prove Clerk's rendered sign-in components, client-side navigation,
actual browser CORS enforcement, responsive layout, or two-window user
experience. Those are the remaining browser-only checks.

## Local runbook

Prerequisites: Node 20+, pnpm 11.24, PostgreSQL, and Redis. Docker Compose can
run the data services; native Homebrew services also work.

```bash
pnpm install
cp apps/server/.env.example apps/server/.env
cp apps/web/.env.example apps/web/.env.local
pnpm --filter @smart-rot/server db:migrate
pnpm --filter @smart-rot/server dev
pnpm --filter @smart-rot/web dev
```

Do not overwrite configured env files when they already exist. The server env
must contain `DATABASE_URL`, `REDIS_URL`, `CLERK_SECRET_KEY`,
`CLERK_PUBLISHABLE_KEY`, and `WEB_ORIGIN`. The web env must contain the matching
Clerk publishable key plus the public REST and realtime URLs.

Quality gates:

```bash
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm --filter @smart-rot/server smoke:live
```

The ordinary server tests fake only the Clerk boundary and use real local
Postgres, Redis session locks, and Colyseus rooms. Their Colyseus presence and
room driver are process-local so a concurrently running dev gateway cannot
claim a test room from the shared Redis registry and return a reservation for a
different endpoint. They namespace and clean their own database users. The live
smoke uses the fixed Clerk identities above and retains them.

## Efficient continuation plan

1. Keep all root gates green and keep the two-account live smoke rerunnable.
2. Run one focused two-session pass through the new navigation and both modes:
   home → Wordle → Speed (verify countdown and refresh recovery) → history, then
   Fewest Guesses (verify the first solver waits and lower guess count wins).
   Record the result here.
3. Treat any failure in that browser check as Phase 1 work. Do not paper over it
   in the next game.
4. After Phase 1 is visually verified, add Sudoku as a `GameEngine` plugin and
   reuse matchmaking, lifecycle, finalization, and ratings unchanged. If those
   generic layers need game-specific branches, stop and reconsider the contract.
5. Add Minesweeper next, explicitly proving identical board generation from one
   shared seed.
6. Add the Wordle bot, then extract only the bot behavior that subsequent games
   genuinely share.
7. Add Spider Solitaire and later games only after the plugin boundary has
   survived the preceding variants.

## Known limitations and next work

- The instant-forfeit half of the hard-refresh retest now passes. Confirming the
  refreshed board resumes and finishes the same match is still outstanding.
- Only Wordle is registered; the roadmap games and bots are not implemented.
- There is no production deployment/observability setup yet.
- Legal/compliance work for any future money feature is deliberately outside
  this codebase's present scope.
- The live smoke mutates the two test users' real development ratings and adds
  real development match-history rows by design; it does not delete history.
