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

/** Verifies a Clerk session JWT and returns the Clerk user id (the `sub` claim). */
export async function verifyClerkAuthToken(token: string | undefined | null): Promise<string> {
  if (!token) {
    throw new UnauthorizedError("Missing auth token");
  }
  try {
    const payload = await verifyToken(token, { secretKey: env.clerkSecretKey });
    return payload.sub;
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

  const clerkUser = await clerkClient.users.getUser(authSubject);
  const displayName =
    clerkUser.username ?? clerkUser.firstName ?? clerkUser.emailAddresses[0]?.emailAddress.split("@")[0] ?? `player-${authSubject.slice(-6)}`;

  return prisma.user.upsert({
    where: { authSubject },
    update: {},
    create: { authSubject, displayName },
  });
}
