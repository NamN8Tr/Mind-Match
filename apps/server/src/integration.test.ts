import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { VALID_GUESSES, wordleEngine, wordleFewestGuessesEngine } from "@smart-rot/game-engines";
import type {
  MatchOpponentInfo,
  MatchResult,
  PlayerId,
  SoloResultMessage,
  WordleMode,
  WordleStateView,
} from "@smart-rot/shared-types";
import { clerkAuth } from "./auth/clerk.js";
import { createColyseusServer } from "./colyseus-server.js";
import { prisma } from "./db/prisma.js";
import { finalizeMatch, getOrCreateRating } from "./matchmaking/match-service.js";
import { redis } from "./redis.js";

/**
 * End-to-end proof of the Wordle vertical slice's riskiest seam: two DISTINCT
 * authenticated users, queued independently, matched together, playing through
 * Colyseus's real auth/join/message pipeline against a real Postgres + Redis —
 * the exact path where the Clerk-subject-used-as-PlayerId bug lived undetected.
 * Unit tests on the engine and rating math can't catch that class of bug; it
 * only surfaces once matchmaking actually resolves a rating row by the wrong id.
 *
 * Requires DATABASE_URL / REDIS_URL pointed at a real (local dev is fine)
 * Postgres and Redis — see the README's "Local development" section.
 *
 * Auth is faked at the `clerkAuth` seam (apps/server/src/auth/clerk.ts) so this
 * needs no live Clerk credentials; the authToken a client passes is treated as
 * the Clerk subject verbatim. Everything downstream of that — JIT user
 * provisioning, rating rows, room authorization — is the real code path.
 */

/**
 * Test users are namespaced per test FILE. Both suites run concurrently
 * against the same database, and a cleanup that deleted every "test-"
 * user would block on (or delete) rows the other suite is still using —
 * which manifests as one file hanging on a row lock, not a clean failure.
 */
const USER_PREFIX = "it-";
const TEST_JOIN_DEADLINE_MS = 750;
const TEST_RECONNECT_GRACE_SECONDS = 0.25;
const TEST_COUNTDOWN_MS = 250;
const TEST_MATCH_TIMEOUT_MS = 750;
const SOLO_TEST_SEED = "integration-solo-seed";
const SPEED_QUEUE = "wordle_speed_matchmaking";
const FEWEST_GUESSES_QUEUE = "wordle_fewest_matchmaking";

interface ClockMessage {
  startedAt: number;
  deadlineAt: number;
  serverNow: number;
}

interface CountdownMessage {
  endsAt: number;
  serverNow: number;
}

interface ResultMessage {
  result: MatchResult;
  ratings: Record<PlayerId, { before: number; after: number }> | null;
  persisted: boolean;
}

function installFakeClerk(): () => void {
  const originalVerify = clerkAuth.verifyToken;
  const originalGetUser = clerkAuth.getUser;
  clerkAuth.verifyToken = async (token: string) => token;
  clerkAuth.getUser = async (authSubject: string) =>
    ({ username: authSubject, firstName: null, emailAddresses: [] }) as unknown as Awaited<ReturnType<typeof originalGetUser>>;
  return () => {
    clerkAuth.verifyToken = originalVerify;
    clerkAuth.getUser = originalGetUser;
  };
}

function nextMessage<T>(room: Room, type: string): Promise<T> {
  return new Promise((resolve) => {
    const unsubscribe = room.onMessage(type, (payload: T) => {
      unsubscribe();
      resolve(payload);
    });
  });
}

function waitForPhase(room: Room, target: string): Promise<void> {
  return new Promise((resolve) => {
    const unsubscribe = room.onMessage("phase", (value: string) => {
      if (value === target) {
        unsubscribe();
        resolve();
      }
    });
  });
}

/** Mirrors the web client: attach listeners first, then ask for the opening snapshot. */
function ready(room: Room): void {
  room.send("ready");
}

interface MatchFixture {
  roomA: Room;
  roomB: Room;
  userAId: string;
  userBId: string;
  matchId: string;
  answer: string;
  countdown: CountdownMessage;
  clock: ClockMessage;
  opponentForA: MatchOpponentInfo;
  opponentForB: MatchOpponentInfo;
}

interface CountdownFixture {
  roomA: Room;
  roomB: Room;
  countdown: CountdownMessage;
}

/** Runs the full queue -> pair -> both-ready flow and returns everything a test needs. */
async function startMatch(
  port: number,
  mode: WordleMode = "speed",
  duringCountdown?: (fixture: CountdownFixture) => Promise<void>,
): Promise<MatchFixture> {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;

  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueName = mode === "speed" ? SPEED_QUEUE : FEWEST_GUESSES_QUEUE;
  const queueA = await clientA.joinOrCreate(queueName, { authToken: subjectA });
  const queueB = await clientB.joinOrCreate(queueName, { authToken: subjectB });

  const [reservationA, reservationB] = await Promise.all([
    nextMessage<SeatReservation>(queueA, "seat"),
    nextMessage<SeatReservation>(queueB, "seat"),
  ]);
  assert.equal(reservationA.roomId, reservationB.roomId, "both players should be paired into the same match room");

  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(reservationA), clientB.consumeSeatReservation(reservationB)]);
  queueA.send("confirm");
  queueB.send("confirm");

  const activeA = waitForPhase(roomA, "active");
  const activeB = waitForPhase(roomB, "active");
  const countdownA = nextMessage<CountdownMessage>(roomA, "countdown");
  const clockA = nextMessage<ClockMessage>(roomA, "clock");
  const opponentForAPromise = nextMessage<MatchOpponentInfo>(roomA, "opponent");
  const opponentForBPromise = nextMessage<MatchOpponentInfo>(roomB, "opponent");
  ready(roomA);
  ready(roomB);
  const [countdown, opponentForA, opponentForB] = await Promise.all([countdownA, opponentForAPromise, opponentForBPromise]);
  await duringCountdown?.({ roomA, roomB, countdown });
  const [, , clock] = await Promise.all([activeA, activeB, clockA]);

  const [userA, userB] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { authSubject: subjectA } }),
    prisma.user.findUniqueOrThrow({ where: { authSubject: subjectB } }),
  ]);

  const match = await prisma.match.findFirstOrThrow({
    where: { participants: { some: { userId: userA.id } }, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  return {
    roomA,
    roomB,
    userAId: userA.id,
    userBId: userB.id,
    matchId: match.id,
    answer: (mode === "speed" ? wordleEngine : wordleFewestGuessesEngine).generateInitialState(match.seed, [userA.id, userB.id]).answer,
    countdown,
    clock,
    opponentForA,
    opponentForB,
  };
}

const port = 18000 + Math.floor(Math.random() * 2000);
const restoreClerk = installFakeClerk();
// Room discovery is local to this test process. Sharing the dev gateway's
// Redis driver would let either process claim a room named "wordle", yielding
// a reservation whose endpoint is wrong for this randomly selected test port.
const gameServer = createColyseusServer({
  isolated: true,
  gameRoom: {
    joinDeadlineMs: TEST_JOIN_DEADLINE_MS,
    reconnectGraceSeconds: TEST_RECONNECT_GRACE_SECONDS,
    countdownMs: TEST_COUNTDOWN_MS,
    matchTimeoutMs: TEST_MATCH_TIMEOUT_MS,
  },
  soloRoom: {
    countdownMs: TEST_COUNTDOWN_MS,
    runTimeoutMs: TEST_MATCH_TIMEOUT_MS,
    seedFactory: () => SOLO_TEST_SEED,
  },
});
await gameServer.listen(port);

after(async () => {
  restoreClerk();
  await gameServer.gracefullyShutdown(false);
  // Matches go first and explicitly: only Rating and MatchParticipant
  // cascade from User, so deleting users alone would strand Match rows.
  const testUsers = await prisma.user.findMany({ where: { authSubject: { startsWith: USER_PREFIX } }, select: { id: true } });
  const testUserIds = testUsers.map((u) => u.id);
  await prisma.match.deleteMany({ where: { participants: { some: { userId: { in: testUserIds } } } } });
  await prisma.user.deleteMany({ where: { id: { in: testUserIds } } });
  await prisma.$disconnect();
  redis.disconnect();
});

test("distinct Clerk subjects resolve to distinct internal user ids, and matchmaking pairs them", async () => {
  const { userAId, userBId, roomA, roomB, matchId, countdown, clock, opponentForA, opponentForB } = await startMatch(port);
  assert.notEqual(userAId, userBId, "distinct Clerk subjects must map to distinct internal users");
  assert.equal(countdown.endsAt - countdown.serverNow, TEST_COUNTDOWN_MS, "both players must receive the server countdown");
  assert.ok(clock.startedAt >= countdown.endsAt, "the match clock must not begin until the ready-up countdown ends");
  assert.equal(clock.deadlineAt - clock.startedAt, TEST_MATCH_TIMEOUT_MS, "the room clock must use the authoritative match deadline");
  const match = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  assert.equal(match.mode, "speed", "the selected queue mode must be persisted");
  // Guards the exact regression: matchmaking must key ratings by the internal
  // cuid, not the Clerk subject, or this row simply won't exist.
  const ratings = await prisma.rating.findMany({
    where: { userId: { in: [userAId, userBId] }, gameId: "wordle", mode: "speed" },
  });
  assert.equal(ratings.length, 2, "both players should have a rating row keyed by their internal id");
  assert.equal(opponentForA.userId, userBId);
  assert.equal(opponentForB.userId, userAId);
  assert.match(opponentForA.displayName, new RegExp(`^${USER_PREFIX}`));
  assert.equal(opponentForA.rating, ratings.find((rating) => rating.userId === userBId)!.rating);
  roomA.leave();
  roomB.leave();
});

test("Speed Solo records a server-timed personal best without creating a ranked match", async () => {
  const subject = `${USER_PREFIX}${randomUUID()}`;
  const client = new Client(`ws://localhost:${port}`);
  const room = await client.create("wordle_speed_solo", { authToken: subject });
  const initialState = nextMessage<WordleStateView>(room, "state");
  const countdown = nextMessage<CountdownMessage>(room, "countdown");
  const active = waitForPhase(room, "active");
  const clock = nextMessage<ClockMessage>(room, "clock");
  ready(room);
  await Promise.all([initialState, countdown, active, clock]);

  const user = await prisma.user.findUniqueOrThrow({ where: { authSubject: subject } });
  const answer = wordleEngine.generateInitialState(SOLO_TEST_SEED, [user.id]).answer;
  const finalState = nextMessage<WordleStateView>(room, "state");
  const result = nextMessage<SoloResultMessage>(room, "soloResult");
  room.send("move", { type: "guess", word: answer });
  const [view, outcome] = await Promise.all([finalState, result]);

  assert.equal(outcome.solved, true);
  assert.equal(outcome.persisted, true);
  assert.equal(outcome.isPersonalBest, true);
  assert.ok(outcome.elapsedMs !== null && outcome.elapsedMs > 0);
  assert.equal(outcome.bestTimeMs, outcome.elapsedMs);
  assert.equal(view.revealedAnswer, answer);

  const [personalBest, rankedMatches] = await Promise.all([
    prisma.personalBest.findUniqueOrThrow({
      where: { userId_gameId_mode: { userId: user.id, gameId: "wordle", mode: "speed" } },
    }),
    prisma.match.count({ where: { participants: { some: { userId: user.id } } } }),
  ]);
  assert.equal(personalBest.bestTimeMs, outcome.elapsedMs);
  assert.equal(rankedMatches, 0, "solo runs must not create ranked match history");
  room.leave();
});

test("moves are rejected throughout the ready-up countdown", async () => {
  let rejected = false;
  const { roomA, roomB } = await startMatch(port, "speed", async ({ roomA: countdownRoom }) => {
    const rejection = nextMessage<{ message: string }>(countdownRoom, "moveRejected");
    countdownRoom.send("move", { type: "guess", word: "crane" });
    assert.match((await rejection).message, /hasn't started/i);
    rejected = true;
  });

  assert.equal(rejected, true);
  roomA.leave();
  roomB.leave();
});

test("fewest-guesses lets a more efficient later solver beat the first solver", async () => {
  const { roomA, roomB, userAId, userBId, matchId, answer } = await startMatch(port, "fewest-guesses");
  const wrongWord = VALID_GUESSES.find((word) => word !== answer)!;

  const aSawWrongGuess = nextMessage<WordleStateView>(roomA, "state");
  roomA.send("move", { type: "guess", word: wrongWord });
  await aSawWrongGuess;

  const bSawOpponentSolve = new Promise<WordleStateView>((resolve) => {
    const unsubscribe = roomB.onMessage("state", (state: WordleStateView) => {
      if (!state.opponent.solved) return;
      unsubscribe();
      resolve(state);
    });
  });
  roomA.send("move", { type: "guess", word: answer }); // A solves in two guesses.
  assert.equal((await bSawOpponentSolve).opponent.solved, true);

  const resultA = nextMessage<ResultMessage>(roomA, "result");
  const resultB = nextMessage<ResultMessage>(roomB, "result");
  roomB.send("move", { type: "guess", word: answer }); // B solves later, but in one guess.
  const [outcomeA, outcomeB] = await Promise.all([resultA, resultB]);

  assert.deepEqual(outcomeA, outcomeB);
  assert.equal(outcomeA.result.status, "win");
  assert.equal(outcomeA.result.winnerId, userBId);
  assert.equal(outcomeA.result.reason, "fewest-guesses");

  const [persisted, modeRatings] = await Promise.all([
    prisma.match.findUniqueOrThrow({ where: { id: matchId } }),
    prisma.rating.findMany({
      where: { userId: { in: [userAId, userBId] }, gameId: "wordle", mode: "fewest-guesses" },
    }),
  ]);
  assert.equal(persisted.mode, "fewest-guesses");
  assert.equal(persisted.winnerId, userBId);
  assert.equal(modeRatings.length, 2, "Fewest Guesses must use its own rating pool");

  roomA.leave();
  roomB.leave();
});

test("fewest-guesses timeout awards the only player who solved", async () => {
  const { roomA, roomB, userAId, matchId, answer } = await startMatch(port, "fewest-guesses");

  const resultA = nextMessage<ResultMessage>(roomA, "result");
  const resultB = nextMessage<ResultMessage>(roomB, "result");
  roomA.send("move", { type: "guess", word: answer });
  const [outcomeA, outcomeB] = await Promise.all([resultA, resultB]);

  assert.deepEqual(outcomeA, outcomeB);
  assert.equal(outcomeA.result.status, "win");
  assert.equal(outcomeA.result.winnerId, userAId);
  assert.equal(outcomeA.result.reason, "fewest-guesses-timeout");

  const persisted = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  assert.equal(persisted.resultReason, "fewest-guesses-timeout");

  roomA.leave();
  roomB.leave();
});

test("a player's state view never exposes the opponent's guessed words", async () => {
  const { roomA, roomB, answer } = await startMatch(port);

  const bSeesAGuess = nextMessage<WordleStateView>(roomB, "state");
  roomA.send("move", { type: "guess", word: answer });
  const bView = await bSeesAGuess;

  assert.equal(bView.opponent.guessCount, 1, "B should see that A has guessed");
  assert.equal(bView.opponent.feedback.length, 1, "B should see A's color-only feedback row");
  assert.deepEqual(bView.opponent.feedback[0], Array(5).fill("correct"));
  assert.ok(!("guesses" in bView.opponent), "but never which words A guessed");

  roomA.leave();
  roomB.leave();
});

test("solving first wins the match, updates both ratings, and persists exactly once", async () => {
  const { roomA, roomB, userAId, userBId, matchId, answer } = await startMatch(port);
  const fewestBefore = await Promise.all([
    getOrCreateRating(userAId, "wordle", "fewest-guesses"),
    getOrCreateRating(userBId, "wordle", "fewest-guesses"),
  ]);

  const resultA = nextMessage<ResultMessage>(roomA, "result");
  const resultB = nextMessage<ResultMessage>(roomB, "result");
  roomA.send("move", { type: "guess", word: answer });
  const [outcomeA, outcomeB] = await Promise.all([resultA, resultB]);

  assert.equal(outcomeA.result.status, "win");
  assert.equal(outcomeA.result.winnerId, userAId);
  assert.equal(outcomeA.persisted, true);
  assert.deepEqual(outcomeA, outcomeB, "both players should see the identical persisted outcome");

  assert.ok(outcomeA.ratings);
  assert.ok(outcomeA.ratings[userAId]!.after > outcomeA.ratings[userAId]!.before, "winner's rating should rise");
  assert.ok(outcomeA.ratings[userBId]!.after < outcomeA.ratings[userBId]!.before, "loser's rating should fall");

  const [persistedMatch, participants] = await Promise.all([
    prisma.match.findUniqueOrThrow({ where: { id: matchId } }),
    prisma.matchParticipant.findMany({ where: { matchId } }),
  ]);
  assert.equal(persistedMatch.status, "COMPLETED");
  assert.equal(persistedMatch.winnerId, userAId);
  assert.equal(participants.length, 2);
  for (const participant of participants) {
    assert.notEqual(participant.ratingAfter, null, "both participants need a persisted post-match rating");
  }

  // Idempotency: a duplicate finalize must return what's already stored and
  // leave the rating rows untouched, never award the delta a second time.
  const duplicate = await finalizeMatch(matchId, "wordle", [userAId, userBId], outcomeA.result, {});
  assert.deepEqual(duplicate.ratings, outcomeA.ratings, "a duplicate finalize should replay the stored outcome");

  const ratingsNow = await prisma.rating.findMany({
    where: { userId: { in: [userAId, userBId] }, gameId: "wordle", mode: "speed" },
  });
  for (const rating of ratingsNow) {
    assert.ok(Math.abs(rating.rating - outcomeA.ratings[rating.userId]!.after) < 1e-9, "duplicate finalize must not change a rating");
  }
  const fewestAfter = await prisma.rating.findMany({
    where: { userId: { in: [userAId, userBId] }, gameId: "wordle", mode: "fewest-guesses" },
    orderBy: { userId: "asc" },
  });
  const sortedFewestBefore = [...fewestBefore].sort((a, b) => a.userId.localeCompare(b.userId));
  assert.deepEqual(
    fewestAfter.map(({ userId, rating, deviation, volatility, ratingPeriodsPlayed }) => ({
      userId,
      rating,
      deviation,
      volatility,
      ratingPeriodsPlayed,
    })),
    sortedFewestBefore.map(({ userId, rating, deviation, volatility, ratingPeriodsPlayed }) => ({
      userId,
      rating,
      deviation,
      volatility,
      ratingPeriodsPlayed,
    })),
    "a Speed result must not alter either player's Fewest Guesses rating",
  );

  roomA.leave();
  roomB.leave();
});

test("moves are rejected until both players are ready", async () => {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;
  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate(SPEED_QUEUE, { authToken: subjectA });
  const queueB = await clientB.joinOrCreate(SPEED_QUEUE, { authToken: subjectB });
  const [reservationA, reservationB] = await Promise.all([
    nextMessage<SeatReservation>(queueA, "seat"),
    nextMessage<SeatReservation>(queueB, "seat"),
  ]);
  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(reservationA), clientB.consumeSeatReservation(reservationB)]);
  queueA.send("confirm");
  queueB.send("confirm");

  // Only A signals ready, so the match must still be in "waiting".
  const waiting = nextMessage<string>(roomA, "phase");
  ready(roomA);
  assert.equal(await waiting, "waiting");

  const rejection = nextMessage<{ message: string }>(roomA, "moveRejected");
  roomA.send("move", { type: "guess", word: "crane" });
  assert.match((await rejection).message, /hasn't started/i);

  roomA.leave();
  roomB.leave();
});

test("a player leaving mid-match forfeits to the opponent", async () => {
  const { roomA, roomB, userBId, matchId } = await startMatch(port);

  const resultB = nextMessage<ResultMessage>(roomB, "result");
  roomA.leave(); // consented leave -> immediate onLeave, no reconnection grace
  const outcome = await resultB;

  assert.equal(outcome.result.status, "win");
  assert.equal(outcome.result.winnerId, userBId, "the remaining player should win");
  assert.equal(outcome.result.reason, "opponent-left");

  const persisted = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  assert.equal(persisted.status, "COMPLETED");
  assert.equal(persisted.winnerId, userBId);

  roomB.leave();
});

test("the same user cannot hold two queue entries for one game at once", async () => {
  const subject = `${USER_PREFIX}${randomUUID()}`;
  const client = new Client(`ws://localhost:${port}`);
  const first = await client.joinOrCreate(SPEED_QUEUE, { authToken: subject });

  await assert.rejects(
    () => new Client(`ws://localhost:${port}`).joinOrCreate(FEWEST_GUESSES_QUEUE, { authToken: subject }),
    "a second concurrent queue entry in another mode must be refused",
  );

  first.leave();
});

test("a player who reconnects within the grace period resumes the same match", async () => {
  const { roomA, roomB, answer, matchId } = await startMatch(port);

  // Establish some state to resume into, so a silent restart would be visible.
  const aSawGuess = nextMessage<{ self: { guesses: unknown[] } }>(roomA, "state");
  roomA.send("move", { type: "guess", word: "crane" });
  await aSawGuess;

  const client = new Client(`ws://localhost:${port}`);
  const token = roomA.reconnectionToken;
  roomA.reconnection.enabled = false;
  await roomA.leave(false); // non-consented -> onDrop -> reconnection grace window

  const resumed = await client.reconnect(token);
  const resumedState = nextMessage<{ self: { guesses: unknown[] }; wordLength: number }>(resumed, "state");
  ready(resumed);
  const state = await resumedState;

  assert.equal(state.self.guesses.length, 1, "the resumed session should still see its earlier guess");

  // And the match is still live and winnable, not forfeited by the drop.
  const result = await (async () => {
    const p = nextMessage<ResultMessage>(resumed, "result");
    resumed.send("move", { type: "guess", word: answer });
    return p;
  })();
  assert.equal(result.result.status, "win");
  assert.equal(result.result.reason, "solved");

  const persisted = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  assert.equal(persisted.status, "COMPLETED");
  assert.equal(persisted.resultReason, "solved", "a reconnect must not be recorded as a forfeit");

  resumed.leave();
  roomB.leave();
});

test("a dropped player who misses the reconnect grace period forfeits exactly once", async () => {
  const { roomA, roomB, userAId, userBId, matchId } = await startMatch(port);

  const resultB = nextMessage<ResultMessage>(roomB, "result");
  roomA.reconnection.enabled = false;
  await roomA.leave(false); // abnormal drop; do not reconnect during the shortened test grace period
  const outcome = await resultB;

  assert.equal(outcome.persisted, true);
  assert.equal(outcome.result.status, "win");
  assert.equal(outcome.result.winnerId, userBId);
  assert.equal(outcome.result.reason, "opponent-left");
  assert.ok(outcome.ratings);

  const duplicate = await finalizeMatch(matchId, "wordle", [userAId, userBId], outcome.result, {});
  assert.deepEqual(duplicate.ratings, outcome.ratings, "a second terminal trigger must replay the forfeit rather than rate it twice");

  const [persisted, ratings] = await Promise.all([
    prisma.match.findUniqueOrThrow({ where: { id: matchId } }),
    prisma.rating.findMany({ where: { userId: { in: [userAId, userBId] }, gameId: "wordle", mode: "speed" } }),
  ]);
  assert.equal(persisted.status, "COMPLETED");
  assert.equal(persisted.winnerId, userBId);
  for (const rating of ratings) {
    assert.ok(Math.abs(rating.rating - outcome.ratings[rating.userId]!.after) < 1e-9, "the stored rating must equal the single reported update");
  }

  roomB.leave();
});

test("the match deadline records a persisted draw and reveals the answer", async () => {
  const { roomA, roomB, userAId, userBId, matchId, answer } = await startMatch(port);

  const finalStateA = nextMessage<WordleStateView>(roomA, "state");
  const resultA = nextMessage<ResultMessage>(roomA, "result");
  const resultB = nextMessage<ResultMessage>(roomB, "result");
  const [state, outcomeA, outcomeB] = await Promise.all([finalStateA, resultA, resultB]);

  assert.equal(state.revealedAnswer, answer, "an orchestration timeout should still reveal Wordle's hidden answer");
  assert.deepEqual(outcomeA, outcomeB);
  assert.equal(outcomeA.persisted, true);
  assert.equal(outcomeA.result.status, "draw");
  assert.equal(outcomeA.result.reason, "timeout");
  assert.equal(outcomeA.result.winnerId, undefined);
  assert.ok(outcomeA.ratings);
  assert.equal(outcomeA.ratings[userAId]!.after, outcomeA.ratings[userAId]!.before);
  assert.equal(outcomeA.ratings[userBId]!.after, outcomeA.ratings[userBId]!.before);

  const persisted = await prisma.match.findUniqueOrThrow({ where: { id: matchId } });
  assert.equal(persisted.status, "COMPLETED");
  assert.equal(persisted.resultStatus, "draw");
  assert.equal(persisted.resultReason, "timeout");

  roomA.leave();
  roomB.leave();
});

test("a match abandoned before both players are ready aborts with no rating change", async () => {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;
  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate(SPEED_QUEUE, { authToken: subjectA });
  const queueB = await clientB.joinOrCreate(SPEED_QUEUE, { authToken: subjectB });
  const [resA, resB] = await Promise.all([nextMessage<SeatReservation>(queueA, "seat"), nextMessage<SeatReservation>(queueB, "seat")]);
  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(resA), clientB.consumeSeatReservation(resB)]);
  queueA.send("confirm");
  queueB.send("confirm");

  const waiting = nextMessage<string>(roomA, "phase");
  ready(roomA); // B never readies
  await waiting;

  const userA = await prisma.user.findUniqueOrThrow({ where: { authSubject: subjectA } });
  const ratingBefore = await prisma.rating.findUniqueOrThrow({
    where: { userId_gameId_mode: { userId: userA.id, gameId: "wordle", mode: "speed" } },
  });
  const match = await prisma.match.findFirstOrThrow({
    where: { participants: { some: { userId: userA.id } }, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });

  const aborted = nextMessage<ResultMessage>(roomB, "result");
  roomA.leave(); // consented leave before the match ever started
  const outcome = await aborted;

  assert.equal(outcome.result.status, "aborted");
  assert.equal(outcome.ratings, null, "an aborted match must report no rating change");

  const persisted = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(persisted.status, "ABORTED");

  const ratingAfter = await prisma.rating.findUniqueOrThrow({
    where: { userId_gameId_mode: { userId: userA.id, gameId: "wordle", mode: "speed" } },
  });
  assert.equal(ratingAfter.rating, ratingBefore.rating, "an aborted match must leave ratings untouched");

  roomB.leave();
});

test("the join deadline aborts a no-show without changing ratings", async () => {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;
  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate(SPEED_QUEUE, { authToken: subjectA });
  const queueB = await clientB.joinOrCreate(SPEED_QUEUE, { authToken: subjectB });
  const [resA, resB] = await Promise.all([nextMessage<SeatReservation>(queueA, "seat"), nextMessage<SeatReservation>(queueB, "seat")]);
  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(resA), clientB.consumeSeatReservation(resB)]);
  queueA.send("confirm");
  queueB.send("confirm");

  const waiting = nextMessage<string>(roomA, "phase");
  ready(roomA); // B connects but never confirms listener readiness.
  assert.equal(await waiting, "waiting");

  const [userA, userB] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { authSubject: subjectA } }),
    prisma.user.findUniqueOrThrow({ where: { authSubject: subjectB } }),
  ]);
  const [ratingsBefore, match] = await Promise.all([
    prisma.rating.findMany({
      where: { userId: { in: [userA.id, userB.id] }, gameId: "wordle", mode: "speed" },
      orderBy: { userId: "asc" },
    }),
    prisma.match.findFirstOrThrow({
      where: { status: "ACTIVE", participants: { some: { userId: userA.id } } },
      orderBy: { createdAt: "desc" },
    }),
  ]);

  const resultA = nextMessage<ResultMessage>(roomA, "result");
  const resultB = nextMessage<ResultMessage>(roomB, "result");
  const [outcomeA, outcomeB] = await Promise.all([resultA, resultB]);

  assert.deepEqual(outcomeA, outcomeB);
  assert.equal(outcomeA.persisted, true);
  assert.equal(outcomeA.result.status, "aborted");
  assert.equal(outcomeA.result.reason, "no-show");
  assert.equal(outcomeA.ratings, null);

  const [persisted, ratingsAfter] = await Promise.all([
    prisma.match.findUniqueOrThrow({ where: { id: match.id } }),
    prisma.rating.findMany({
      where: { userId: { in: [userA.id, userB.id] }, gameId: "wordle", mode: "speed" },
      orderBy: { userId: "asc" },
    }),
  ]);
  assert.equal(persisted.status, "ABORTED");
  assert.deepEqual(ratingsAfter, ratingsBefore, "the timer-driven no-show must not mutate either rating row");

  roomA.leave();
  roomB.leave();
});
