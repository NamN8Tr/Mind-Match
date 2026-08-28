import "dotenv/config";
import assert from "node:assert/strict";
import { Client, type Room, type SeatReservation } from "@colyseus/sdk";
import { VALID_GUESSES, wordleEngine } from "@smart-rot/game-engines";
import type { MatchResult, PlayerId, WordleStateView } from "@smart-rot/shared-types";
import { clerkClient } from "../auth/clerk.js";
import { prisma } from "../db/prisma.js";
import { env } from "../env.js";

/**
 * Live smoke test for the production-shaped auth and multiplayer path.
 *
 * This intentionally reuses exactly two Clerk development test users. It never
 * deletes them or creates a random account per run. The short-lived sessions
 * created below are the only Clerk resources revoked during cleanup.
 */
const TEST_PROFILES = [
  {
    slot: "player-one",
    email: "smartrot-player-one+clerk_test@example.com",
    firstName: "Smart Rot One",
    lastName: "Test Player",
  },
  {
    slot: "player-two",
    email: "smartrot-player-two+clerk_test@example.com",
    firstName: "Smart Rot Two",
    lastName: "Test Player",
  },
] as const;

const MESSAGE_TIMEOUT_MS = 20_000;
const apiBaseUrl = `http://127.0.0.1:${env.port}`;
const realtimeUrl = `ws://127.0.0.1:${env.colyseusPort}`;

interface MeResponse {
  id: PlayerId;
  displayName: string;
  ratings: Array<{
    gameId: string;
    mode: string;
    rating: number;
    deviation: number;
    volatility: number;
    ratingPeriodsPlayed: number;
  }>;
}

interface MatchHistoryEntry {
  matchId: string;
  gameId: string;
  mode: string;
  status: string;
  resultStatus: string | null;
  resultReason: string | null;
  ratingBefore: number;
  ratingAfter: number | null;
  players: Array<{ userId: PlayerId; displayName: string; isWinner: boolean }>;
}

interface ResultMessage {
  result: MatchResult;
  ratings: Record<PlayerId, { before: number; after: number }> | null;
  persisted: boolean;
}

interface SmokeIdentity {
  slot: (typeof TEST_PROFILES)[number]["slot"];
  email: string;
  clerkUserId: string;
  sessionId: string;
  token: string;
  me: MeResponse;
  created: boolean;
}

function wordleRating(me: MeResponse, mode = "speed"): number {
  const rating = me.ratings.find((entry) => entry.gameId === "wordle" && entry.mode === mode);
  assert.ok(rating, `${me.displayName} is missing a Wordle ${mode} rating`);
  return rating.rating;
}

function nextMessage<T>(room: Room, type: string, timeoutMs = MESSAGE_TIMEOUT_MS): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for Colyseus message \"${type}\"`));
    }, timeoutMs);
    const unsubscribe = room.onMessage(type, (payload: T) => {
      clearTimeout(timer);
      unsubscribe();
      resolve(payload);
    });
  });
}

function waitForPhase(room: Room, target: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for match phase \"${target}\"`));
    }, MESSAGE_TIMEOUT_MS);
    const unsubscribe = room.onMessage("phase", (phase: string) => {
      if (phase !== target) return;
      clearTimeout(timer);
      unsubscribe();
      resolve();
    });
  });
}

/** Keep expected progress snapshots quiet after a one-shot assertion unsubscribes. */
function ignoreUnhandledMessages(room: Room): void {
  room.onMessage("*", () => undefined);
}

async function apiGet<T>(path: string, token: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    headers: {
      authorization: `Bearer ${token}`,
      origin: env.webOrigin,
    },
  });
  const body = await response.text();
  assert.equal(response.status, 200, `${path} returned ${response.status}: ${body}`);
  assert.equal(response.headers.get("access-control-allow-origin"), env.webOrigin, `${path} did not return the configured CORS origin`);
  return JSON.parse(body) as T;
}

async function ensureTestUser(profile: (typeof TEST_PROFILES)[number]) {
  const existing = await clerkClient.users.getUserList({ emailAddress: [profile.email], limit: 2 });
  assert.ok(existing.data.length <= 1, `Expected at most one Clerk user for ${profile.email}; found ${existing.data.length}`);

  if (existing.data[0]) {
    return { user: existing.data[0], created: false };
  }

  try {
    const user = await clerkClient.users.createUser({
      emailAddress: [profile.email],
      firstName: profile.firstName,
      lastName: profile.lastName,
      skipPasswordRequirement: true,
      privateMetadata: {
        smartRotPurpose: "persistent-live-smoke",
        smartRotSlot: profile.slot,
      },
    });
    return { user, created: true };
  } catch (error) {
    throw new Error(
      `Could not create the fixed Clerk test user ${profile.email}. Make sure the development Clerk application allows a non-password sign-in method (email code is recommended). No fallback account was created.`,
      { cause: error },
    );
  }
}

async function createIdentity(profile: (typeof TEST_PROFILES)[number]): Promise<SmokeIdentity> {
  const { user, created } = await ensureTestUser(profile);
  const session = await clerkClient.sessions.createSession({ userId: user.id });
  const { jwt } = await clerkClient.sessions.getToken(session.id);
  const me = await apiGet<MeResponse>("/api/me", jwt);

  return {
    slot: profile.slot,
    email: profile.email,
    clerkUserId: user.id,
    sessionId: session.id,
    token: jwt,
    me,
    created,
  };
}

async function safeLeave(room: Room | undefined): Promise<void> {
  if (!room) return;
  try {
    await room.leave(true);
  } catch {
    // A completed room or already-dropped socket is expected to be closed.
  }
}

async function main(): Promise<void> {
  const sessionsToRevoke: string[] = [];
  const roomsToLeave = new Set<Room>();

  try {
    const identities: SmokeIdentity[] = [];
    for (const profile of TEST_PROFILES) {
      const identity = await createIdentity(profile);
      identities.push(identity);
      sessionsToRevoke.push(identity.sessionId);
      console.log(`${identity.created ? "Created" : "Reused"} fixed Clerk test user: ${identity.email}`);
    }

    const [firstIdentity, secondIdentity] = identities;
    assert.ok(firstIdentity && secondIdentity, "The smoke test requires exactly two identities");
    assert.notEqual(firstIdentity.clerkUserId, secondIdentity.clerkUserId, "The two test emails resolved to the same Clerk user");
    assert.notEqual(firstIdentity.me.id, secondIdentity.me.id, "The two Clerk users resolved to the same internal user");

    // Make the lower-rated player win. Repeated smoke runs then pull the pair
    // toward each other instead of pushing them outside the initial queue window.
    const [winner, opponent] = [...identities].sort((a, b) => wordleRating(a.me) - wordleRating(b.me));
    assert.ok(winner && opponent);

    const winnerClient = new Client(realtimeUrl);
    const opponentClient = new Client(realtimeUrl);
    const winnerQueue = await winnerClient.joinOrCreate("wordle_speed_matchmaking", { authToken: winner.token });
    roomsToLeave.add(winnerQueue);
    ignoreUnhandledMessages(winnerQueue);
    const winnerSeatPromise = nextMessage<SeatReservation>(winnerQueue, "seat");
    const opponentQueue = await opponentClient.joinOrCreate("wordle_speed_matchmaking", { authToken: opponent.token });
    roomsToLeave.add(opponentQueue);
    ignoreUnhandledMessages(opponentQueue);

    const [winnerSeat, opponentSeat] = await Promise.all([
      winnerSeatPromise,
      nextMessage<SeatReservation>(opponentQueue, "seat"),
    ]);
    assert.equal(winnerSeat.roomId, opponentSeat.roomId, "Matchmaking did not pair both users into the same room");

    let winnerRoom = await winnerClient.consumeSeatReservation(winnerSeat);
    const opponentRoom = await opponentClient.consumeSeatReservation(opponentSeat);
    roomsToLeave.add(winnerRoom);
    roomsToLeave.add(opponentRoom);
    ignoreUnhandledMessages(winnerRoom);
    ignoreUnhandledMessages(opponentRoom);
    winnerQueue.send("confirm");
    opponentQueue.send("confirm");
    roomsToLeave.delete(winnerQueue);
    roomsToLeave.delete(opponentQueue);

    const activeForWinner = waitForPhase(winnerRoom, "active");
    const activeForOpponent = waitForPhase(opponentRoom, "active");
    winnerRoom.send("ready");
    opponentRoom.send("ready");
    await Promise.all([activeForWinner, activeForOpponent]);

    const match = await prisma.match.findFirstOrThrow({
      where: {
        status: "ACTIVE",
        AND: [
          { participants: { some: { userId: winner.me.id } } },
          { participants: { some: { userId: opponent.me.id } } },
        ],
      },
      orderBy: { createdAt: "desc" },
    });
    const answer = wordleEngine.generateInitialState(match.seed, [winner.me.id, opponent.me.id]).answer;
    assert.equal(match.mode, "speed", "The speed smoke queue did not persist its selected mode");
    const wrongGuess = VALID_GUESSES.find((word) => word !== answer);
    assert.ok(wrongGuess, "Could not select a valid non-answer Wordle guess");

    const stateAfterWrongGuess = nextMessage<WordleStateView>(winnerRoom, "state");
    winnerRoom.send("move", { type: "guess", word: wrongGuess });
    assert.equal((await stateAfterWrongGuess).self.guesses.length, 1, "The server did not apply the first guess");

    const reconnectionToken = winnerRoom.reconnectionToken;
    winnerRoom.reconnection.enabled = false;
    await winnerRoom.leave(false);
    roomsToLeave.delete(winnerRoom);
    const reconnectingClient = new Client(realtimeUrl);
    winnerRoom = await reconnectingClient.reconnect(reconnectionToken);
    roomsToLeave.add(winnerRoom);
    ignoreUnhandledMessages(winnerRoom);

    const resumedStatePromise = nextMessage<WordleStateView>(winnerRoom, "state");
    winnerRoom.send("ready");
    const resumedState = await resumedStatePromise;
    assert.equal(resumedState.self.guesses.length, 1, "Reconnect lost the player's existing guesses");

    const winnerResultPromise = nextMessage<ResultMessage>(winnerRoom, "result");
    const opponentResultPromise = nextMessage<ResultMessage>(opponentRoom, "result");
    winnerRoom.send("move", { type: "guess", word: answer });
    const [winnerResult, opponentResult] = await Promise.all([winnerResultPromise, opponentResultPromise]);

    assert.deepEqual(winnerResult, opponentResult, "Both players did not receive the same match outcome");
    assert.equal(winnerResult.persisted, true, "The server reported an unpersisted result");
    assert.equal(winnerResult.result.status, "win");
    assert.equal(winnerResult.result.winnerId, winner.me.id);
    assert.equal(winnerResult.result.reason, "solved");
    assert.ok(winnerResult.ratings, "A ranked win did not include rating changes");
    assert.ok(winnerResult.ratings[winner.me.id]!.after > winnerResult.ratings[winner.me.id]!.before, "Winner rating did not increase");
    assert.ok(winnerResult.ratings[opponent.me.id]!.after < winnerResult.ratings[opponent.me.id]!.before, "Opponent rating did not decrease");

    const [winnerAfter, opponentAfter, winnerHistory, opponentHistory] = await Promise.all([
      apiGet<MeResponse>("/api/me", winner.token),
      apiGet<MeResponse>("/api/me", opponent.token),
      apiGet<MatchHistoryEntry[]>("/api/matches?gameId=wordle&limit=20", winner.token),
      apiGet<MatchHistoryEntry[]>("/api/matches?gameId=wordle&limit=20", opponent.token),
    ]);
    assert.ok(wordleRating(winnerAfter) > wordleRating(winner.me), "The REST profile did not expose the winner's new rating");
    assert.ok(wordleRating(opponentAfter) < wordleRating(opponent.me), "The REST profile did not expose the opponent's new rating");
    assert.ok(winnerHistory.some((entry) => entry.matchId === match.id), "Winner history is missing the completed match");
    assert.ok(opponentHistory.some((entry) => entry.matchId === match.id), "Opponent history is missing the completed match");

    console.log(`Live smoke passed: Clerk auth -> REST/CORS -> matchmaking -> match ${match.id} -> reconnect -> persisted ratings/history.`);
    console.log(`Winner role: ${winner.email}; the lower-rated account is selected each run to keep both reusable accounts balanced.`);
  } finally {
    await Promise.allSettled([...roomsToLeave].map((room) => safeLeave(room)));
    await Promise.allSettled(sessionsToRevoke.map((sessionId) => clerkClient.sessions.revokeSession(sessionId)));
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
