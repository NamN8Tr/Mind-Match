import type { GameId, PlayerId } from "@smart-rot/shared-types";
import { redis } from "../redis.js";

/**
 * Prevents one user from being in two places at once for a given game — two
 * queue tickets, or a queue ticket while already in a match. Held for the
 * whole queue-wait + match duration (acquired once in matchmaking onAuth,
 * released once by finalizeMatch), with a generous TTL as a crash-safety net
 * so a dead process can't strand someone locked out forever.
 */

const LOCK_TTL_SECONDS = 15 * 60;

function sessionKey(gameId: GameId, userId: PlayerId): string {
  return `active-session:${gameId}:${userId}`;
}

/** Returns true if the lock was acquired, false if the user already holds one. */
export async function acquireSession(gameId: GameId, userId: PlayerId, label: string): Promise<boolean> {
  const result = await redis.set(sessionKey(gameId, userId), label, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseSession(gameId: GameId, userId: PlayerId): Promise<void> {
  await redis.del(sessionKey(gameId, userId));
}
