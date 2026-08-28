import "dotenv/config";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import type { FastifyInstance } from "fastify";
import { DEFAULT_GLICKO2_RATING } from "@smart-rot/shared-types";
import { buildApp } from "../app.js";
import { clerkAuth } from "../auth/clerk.js";
import { prisma } from "../db/prisma.js";

/**
 * REST-surface tests: authorization on every protected route, the CORS
 * contract the browser enforces on the web app's cross-origin calls, and that
 * /api/me reports the caller's own internal id (not their Clerk subject).
 *
 * Auth is faked at the `clerkAuth` seam — the bearer token is treated as the
 * Clerk subject verbatim. See integration.test.ts for the same approach.
 */

/** Namespaced per test file so concurrent suites never delete each other's rows. */
const USER_PREFIX = "api-";

const originalVerify = clerkAuth.verifyToken;
const originalGetUser = clerkAuth.getUser;
clerkAuth.verifyToken = async (token: string) => {
  if (!token.startsWith(USER_PREFIX)) throw new Error("bad token");
  return token;
};
clerkAuth.getUser = async (authSubject: string) =>
  ({ username: authSubject, firstName: null, emailAddresses: [] }) as unknown as Awaited<ReturnType<typeof originalGetUser>>;

const app: FastifyInstance = await buildApp({ logger: false });
const WEB_ORIGIN = process.env["WEB_ORIGIN"]!;

after(async () => {
  clerkAuth.verifyToken = originalVerify;
  clerkAuth.getUser = originalGetUser;
  await app.close();
  const testUsers = await prisma.user.findMany({ where: { authSubject: { startsWith: USER_PREFIX } }, select: { id: true } });
  const ids = testUsers.map((u) => u.id);
  await prisma.match.deleteMany({ where: { participants: { some: { userId: { in: ids } } } } });
  await prisma.user.deleteMany({ where: { id: { in: ids } } });
  await prisma.$disconnect();
});

test("protected routes reject a request with no token", async () => {
  for (const url of ["/api/me", "/api/matches", "/api/players/not-a-player"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `${url} should require auth`);
  }
  const updateResponse = await app.inject({ method: "PATCH", url: "/api/me", payload: { username: "NoAuth" } });
  assert.equal(updateResponse.statusCode, 401, "profile updates should require auth");
  const deleteResponse = await app.inject({ method: "DELETE", url: "/api/me" });
  assert.equal(deleteResponse.statusCode, 401, "profile deletion should require auth");
});

test("protected routes reject a malformed or unverifiable token", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: "Bearer not-a-valid-token" },
  });
  assert.equal(response.statusCode, 401);
});

test("/health is public", async () => {
  const response = await app.inject({ method: "GET", url: "/health" });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { status: "ok" });
});

test("/api/me returns the caller's internal id and seeds both mode ratings", async () => {
  const subject = `${USER_PREFIX}${randomUUID()}`;
  const response = await app.inject({
    method: "GET",
    url: "/api/me",
    headers: { authorization: `Bearer ${subject}` },
  });

  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    id: string;
    displayName: string;
    ratings: { gameId: string; mode: string; rating: number; userId: string }[];
    personalBests: unknown[];
  };

  const user = await prisma.user.findUniqueOrThrow({ where: { authSubject: subject } });
  assert.equal(body.id, user.id, "/api/me must report the internal user id, never the Clerk subject");
  assert.notEqual(body.id, subject);

  const speed = body.ratings.find((rating) => rating.gameId === "wordle" && rating.mode === "speed");
  const fewest = body.ratings.find((rating) => rating.gameId === "wordle" && rating.mode === "fewest-guesses");
  assert.ok(speed, "a new player should be seeded with a Speed rating");
  assert.ok(fewest, "a new player should be seeded with a Fewest Guesses rating");
  assert.equal(speed.rating, DEFAULT_GLICKO2_RATING);
  assert.equal(fewest.rating, DEFAULT_GLICKO2_RATING);
  assert.equal(speed.userId, user.id, "ratings must be keyed by the internal user id");
  assert.equal(fewest.userId, user.id, "both mode ratings must belong to the internal user id");
  assert.deepEqual(body.personalBests, []);
});

test("a player can update their username with server-side validation", async () => {
  const subject = `${USER_PREFIX}${randomUUID()}`;
  await app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${subject}` } });

  const invalid = await app.inject({
    method: "PATCH",
    url: "/api/me",
    headers: { authorization: `Bearer ${subject}` },
    payload: { username: "no spaces allowed" },
  });
  assert.equal(invalid.statusCode, 400);

  const valid = await app.inject({
    method: "PATCH",
    url: "/api/me",
    headers: { authorization: `Bearer ${subject}` },
    payload: { username: "Puzzle_Player" },
  });
  assert.equal(valid.statusCode, 200);
  assert.equal((valid.json() as { displayName: string }).displayName, "Puzzle_Player");

  const stored = await prisma.user.findUniqueOrThrow({ where: { authSubject: subject } });
  assert.equal(stored.displayName, "Puzzle_Player");
});

test("a player can permanently delete their Smart Rot profile data", async () => {
  const subject = `${USER_PREFIX}${randomUUID()}`;
  const opponentSubject = `${USER_PREFIX}${randomUUID()}`;
  await Promise.all(
    [subject, opponentSubject].map((authSubject) =>
      app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${authSubject}` } }),
    ),
  );
  const [user, opponent] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { authSubject: subject } }),
    prisma.user.findUniqueOrThrow({ where: { authSubject: opponentSubject } }),
  ]);
  const match = await prisma.match.create({
    data: {
      gameId: "wordle",
      mode: "speed",
      seed: "profile-deletion-test",
      status: "COMPLETED",
      completedAt: new Date(),
      resultStatus: "win",
      resultReason: "solved",
      winnerId: user.id,
      participants: {
        create: [
          { userId: user.id, ratingBefore: 400, deviationBefore: 100, ratingAfter: 426, deviationAfter: 96, scoreForRating: 1 },
          { userId: opponent.id, ratingBefore: 400, deviationBefore: 100, ratingAfter: 374, deviationAfter: 96, scoreForRating: 0 },
        ],
      },
    },
  });
  await prisma.personalBest.create({
    data: { userId: user.id, gameId: "wordle", mode: "speed", bestTimeMs: 9_876 },
  });

  const response = await app.inject({
    method: "DELETE",
    url: "/api/me",
    headers: { authorization: `Bearer ${subject}` },
  });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json(), { deleted: true });

  assert.equal(await prisma.user.findUnique({ where: { id: user.id } }), null);
  assert.equal(await prisma.rating.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.personalBest.count({ where: { userId: user.id } }), 0);
  assert.equal(await prisma.matchParticipant.count({ where: { userId: user.id } }), 0);
  const retainedMatch = await prisma.match.findUniqueOrThrow({ where: { id: match.id } });
  assert.equal(retainedMatch.winnerId, null, "matches must not retain a foreign key to a deleted winner");
});

test("a signed-in player can view another player's safe public profile", async () => {
  const viewerSubject = `${USER_PREFIX}${randomUUID()}`;
  const playerSubject = `${USER_PREFIX}${randomUUID()}`;
  await Promise.all(
    [viewerSubject, playerSubject].map((subject) =>
      app.inject({ method: "GET", url: "/api/me", headers: { authorization: `Bearer ${subject}` } }),
    ),
  );
  const [viewer, player] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { authSubject: viewerSubject } }),
    prisma.user.findUniqueOrThrow({ where: { authSubject: playerSubject } }),
  ]);
  await prisma.user.update({ where: { id: player.id }, data: { displayName: "Public_Player" } });
  await prisma.personalBest.create({
    data: { userId: player.id, gameId: "wordle", mode: "speed", bestTimeMs: 12_345 },
  });
  const match = await prisma.match.create({
    data: {
      gameId: "wordle",
      mode: "speed",
      seed: "public-profile-test",
      status: "COMPLETED",
      completedAt: new Date(),
      resultStatus: "win",
      resultReason: "solved",
      winnerId: player.id,
      participants: {
        create: [
          { userId: player.id, ratingBefore: 400, deviationBefore: 100, ratingAfter: 426, deviationAfter: 96, scoreForRating: 1 },
          { userId: viewer.id, ratingBefore: 400, deviationBefore: 100, ratingAfter: 374, deviationAfter: 96, scoreForRating: 0 },
        ],
      },
    },
  });

  const response = await app.inject({
    method: "GET",
    url: `/api/players/${player.id}`,
    headers: { authorization: `Bearer ${viewerSubject}` },
  });
  assert.equal(response.statusCode, 200);
  const body = response.json() as {
    id: string;
    displayName: string;
    ratings: Array<{ gameId: string; mode: string }>;
    personalBests: Array<{ bestTimeMs: number }>;
    stats: { rankedMatches: number; wins: number; draws: number; losses: number };
    matches: Array<{ matchId: string; players: Array<{ userId: string; displayName: string }> }>;
    authSubject?: string;
  };
  assert.equal(body.id, player.id);
  assert.equal(body.displayName, "Public_Player");
  assert.equal(body.ratings.length, 2);
  assert.equal(body.personalBests[0]?.bestTimeMs, 12_345);
  assert.deepEqual(body.stats, { rankedMatches: 1, wins: 1, draws: 0, losses: 0 });
  assert.equal(body.matches[0]?.matchId, match.id);
  assert.ok(body.matches[0]?.players.some((entry) => entry.userId === viewer.id));
  assert.equal(body.authSubject, undefined, "the public profile must never expose the Clerk subject");

  const missing = await app.inject({
    method: "GET",
    url: "/api/players/missing-player",
    headers: { authorization: `Bearer ${viewerSubject}` },
  });
  assert.equal(missing.statusCode, 404);
  assert.deepEqual(missing.json(), { error: "Player not found" });
});

test("a delete preflight from the configured web origin is allowed with the Authorization header", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/me",
    headers: {
      origin: WEB_ORIGIN,
      "access-control-request-method": "DELETE",
      "access-control-request-headers": "authorization",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], WEB_ORIGIN);
  assert.match(String(response.headers["access-control-allow-headers"]), /authorization/i);
  assert.match(String(response.headers["access-control-allow-methods"]), /DELETE/i);
});

test("a request from an unconfigured origin is not granted CORS access", async () => {
  const response = await app.inject({
    method: "GET",
    url: "/health",
    headers: { origin: "https://evil.example.com" },
  });

  // The response still returns (CORS is enforced by the browser, not the
  // server), but it must not carry an allow-origin header naming the caller.
  assert.notEqual(response.headers["access-control-allow-origin"], "https://evil.example.com");
});
