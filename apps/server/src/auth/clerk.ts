import { createClerkClient, verifyToken } from "@clerk/backend";
import { env } from "../env.js";
import { prisma } from "../db/prisma.js";
import type { User } from "../generated/prisma/client.js";

export const clerkClient = createClerkClient({
  secretKey: env.clerkSecretKey,
  publishableKey: env.clerkPublishableKey,
});

export class UnauthorizedError extends Error {
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Every real touchpoint with Clerk's own backend goes through this object
 * rather than being called directly, so tests can swap in a fake without a
 * live Clerk instance — see the seam note on each method. Nothing outside
 * this file or a test should need to reassign these.
 */
export const clerkAuth = {
  /** Verifies a Clerk session JWT and returns the Clerk user id (the `sub` claim). Throws on an invalid/expired token. */
  async verifyToken(token: string): Promise<string> {
    const payload = await verifyToken(token, { secretKey: env.clerkSecretKey });
    return payload.sub;
  },
  /** Fetches a Clerk user's profile, used once per new user to seed a display name. */
  async getUser(authSubject: string) {
    return clerkClient.users.getUser(authSubject);
  },
};

/** Verifies a Clerk session JWT and returns the Clerk user id (the `sub` claim). */
export async function verifyClerkAuthToken(token: string | undefined | null): Promise<string> {
  if (!token) {
    throw new UnauthorizedError("Missing auth token");
  }
  try {
    return await clerkAuth.verifyToken(token);
  } catch {
    throw new UnauthorizedError("Invalid or expired auth token");
  }
}

/**
 * Just-in-time user provisioning: the first time we see a Clerk subject, create
 * our own User row for it (fetching a display name from Clerk once). Every
 * subsequent request just reads the existing row. Simpler than wiring up Clerk
 * webhooks for Phase 1; revisit if we need to react to profile edits/deletes.
 */
export async function ensureUserForAuthSubject(authSubject: string): Promise<User> {
  const existing = await prisma.user.findUnique({ where: { authSubject } });
  if (existing) {
    return existing;
  }

  const clerkUser = await clerkAuth.getUser(authSubject);
  const displayName =
    clerkUser.username ?? clerkUser.firstName ?? clerkUser.emailAddresses[0]?.emailAddress.split("@")[0] ?? `player-${authSubject.slice(-6)}`;

  return prisma.user.upsert({
    where: { authSubject },
    update: {},
    create: { authSubject, displayName },
  });
}

/**
 * The one function every authenticated entry point (REST routes, the
 * matchmaking room, game rooms) should call. Verifying a Clerk token only
 * gets you the Clerk *subject* — an external id in Clerk's own id space, not
 * a PlayerId. Every internal id (Rating.userId, Match participants, the
 * `playerIds` a game room checks) is our own Prisma User.id (a cuid).
 * Treating the Clerk subject as if it were that id — e.g. passing it straight
 * into getOrCreateRating — breaks the moment Prisma tries to satisfy a
 * foreign key against a User row that doesn't exist at that id.
 */
export async function resolveAuthenticatedUser(token: string | undefined | null): Promise<User> {
  const authSubject = await verifyClerkAuthToken(token);
  return ensureUserForAuthSubject(authSubject);
}
