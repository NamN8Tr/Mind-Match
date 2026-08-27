import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { wordleEngine } from "@smart-rot/game-engines";
import type { MatchResult, PlayerId } from "@smart-rot/shared-types";
import { clerkAuth } from "./auth/clerk.js";
import { createColyseusServer } from "./colyseus-server.js";
import { prisma } from "./db/prisma.js";
import { finalizeMatch } from "./matchmaking/match-service.js";
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
}

/** Runs the full queue -> pair -> both-ready flow and returns everything a test needs. */
async function startMatch(port: number): Promise<MatchFixture> {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;

  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate("wordle_matchmaking", { authToken: subjectA });
  const queueB = await clientB.joinOrCreate("wordle_matchmaking", { authToken: subjectB });

  const [reservationA, reservationB] = await Promise.all([
    nextMessage<SeatReservation>(queueA, "seat"),
    nextMessage<SeatReservation>(queueB, "seat"),
  ]);
  assert.equal(reservationA.roomId, reservationB.roomId, "both players should be paired into the same match room");

  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(reservationA), clientB.consumeSeatReservation(reservationB)]);

  const activeA = waitForPhase(roomA, "active");
  const activeB = waitForPhase(roomB, "active");
  ready(roomA);
  ready(roomB);
  await Promise.all([activeA, activeB]);

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
    answer: wordleEngine.generateInitialState(match.seed, [userA.id, userB.id]).answer,
  };
}

const port = 18000 + Math.floor(Math.random() * 2000);
const restoreClerk = installFakeClerk();
const gameServer = createColyseusServer();
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
  const { userAId, userBId, roomA, roomB } = await startMatch(port);
  assert.notEqual(userAId, userBId, "distinct Clerk subjects must map to distinct internal users");
  // Guards the exact regression: matchmaking must key ratings by the internal
  // cuid, not the Clerk subject, or this row simply won't exist.
  const ratings = await prisma.rating.findMany({ where: { userId: { in: [userAId, userBId] }, gameId: "wordle" } });
  assert.equal(ratings.length, 2, "both players should have a rating row keyed by their internal id");
  roomA.leave();
  roomB.leave();
});

test("a player's state view never exposes the opponent's guessed words", async () => {
  const { roomA, roomB, answer } = await startMatch(port);

  const bSeesAGuess = nextMessage<{ opponent: { guessCount: number } }>(roomB, "state");
  roomA.send("move", { type: "guess", word: answer });
  const bView = await bSeesAGuess;

  assert.equal(bView.opponent.guessCount, 1, "B should see that A has guessed");
  assert.ok(!("guesses" in bView.opponent), "but never which words A guessed");

  roomA.leave();
  roomB.leave();
});

test("solving first wins the match, updates both ratings, and persists exactly once", async () => {
  const { roomA, roomB, userAId, userBId, matchId, answer } = await startMatch(port);

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

  const ratingsNow = await prisma.rating.findMany({ where: { userId: { in: [userAId, userBId] }, gameId: "wordle" } });
  for (const rating of ratingsNow) {
    assert.ok(Math.abs(rating.rating - outcomeA.ratings[rating.userId]!.after) < 1e-9, "duplicate finalize must not change a rating");
  }

  roomA.leave();
  roomB.leave();
});

test("moves are rejected until both players are ready", async () => {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;
  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate("wordle_matchmaking", { authToken: subjectA });
  const queueB = await clientB.joinOrCreate("wordle_matchmaking", { authToken: subjectB });
  const [reservationA, reservationB] = await Promise.all([
    nextMessage<SeatReservation>(queueA, "seat"),
    nextMessage<SeatReservation>(queueB, "seat"),
  ]);
  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(reservationA), clientB.consumeSeatReservation(reservationB)]);

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
  const first = await client.joinOrCreate("wordle_matchmaking", { authToken: subject });

  await assert.rejects(
    () => new Client(`ws://localhost:${port}`).joinOrCreate("wordle_matchmaking", { authToken: subject }),
    "a second concurrent queue entry for the same user must be refused",
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

test("a match abandoned before both players are ready aborts with no rating change", async () => {
  const subjectA = `${USER_PREFIX}${randomUUID()}`;
  const subjectB = `${USER_PREFIX}${randomUUID()}`;
  const clientA = new Client(`ws://localhost:${port}`);
  const clientB = new Client(`ws://localhost:${port}`);

  const queueA = await clientA.joinOrCreate("wordle_matchmaking", { authToken: subjectA });
  const queueB = await clientB.joinOrCreate("wordle_matchmaking", { authToken: subjectB });
  const [resA, resB] = await Promise.all([nextMessage<SeatReservation>(queueA, "seat"), nextMessage<SeatReservation>(queueB, "seat")]);
  const [roomA, roomB] = await Promise.all([clientA.consumeSeatReservation(resA), clientB.consumeSeatReservation(resB)]);

  const waiting = nextMessage<string>(roomA, "phase");
  ready(roomA); // B never readies
  await waiting;

  const userA = await prisma.user.findUniqueOrThrow({ where: { authSubject: subjectA } });
  const ratingBefore = await prisma.rating.findUniqueOrThrow({ where: { userId_gameId: { userId: userA.id, gameId: "wordle" } } });
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

  const ratingAfter = await prisma.rating.findUniqueOrThrow({ where: { userId_gameId: { userId: userA.id, gameId: "wordle" } } });
  assert.equal(ratingAfter.rating, ratingBefore.rating, "an aborted match must leave ratings untouched");

  roomB.leave();
});
