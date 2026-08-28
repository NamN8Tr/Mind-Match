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
  for (const url of ["/api/me", "/api/matches"]) {
    const response = await app.inject({ method: "GET", url });
    assert.equal(response.statusCode, 401, `${url} should require auth`);
  }
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
});

test("a preflight from the configured web origin is allowed with the Authorization header", async () => {
  const response = await app.inject({
    method: "OPTIONS",
    url: "/api/me",
    headers: {
      origin: WEB_ORIGIN,
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers["access-control-allow-origin"], WEB_ORIGIN);
  assert.match(String(response.headers["access-control-allow-headers"]), /authorization/i);
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
