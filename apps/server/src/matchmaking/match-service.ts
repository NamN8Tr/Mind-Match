import type { GameId, MatchResult, PlayerId } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { applyAndPersistMatchResult, getOrCreateRating, type Db, type MatchOutcome } from "../rating/service.js";
import { releaseSession } from "./session-lock.js";

export interface PendingMatchPlayer {
  userId: PlayerId;
  ratingBefore: number;
  deviationBefore: number;
}

/**
 * Creates the Postgres record for a match matchmaking just paired, snapshotting
 * each player's rating at the moment the match starts. Returns the new match id,
 * used as the Colyseus room's matchId.
 */
export async function createPendingMatch(gameId: GameId, mode: string, seed: string, players: PendingMatchPlayer[]): Promise<string> {
  const match = await prisma.match.create({
    data: {
      gameId,
      mode,
      seed,
      status: "ACTIVE",
      participants: {
        create: players.map((p) => ({
          userId: p.userId,
          ratingBefore: p.ratingBefore,
          deviationBefore: p.deviationBefore,
        })),
      },
    },
  });
  return match.id;
}

function outcomeFor(result: MatchResult, playerId: PlayerId): MatchOutcome {
  if (result.status === "draw") return "draw";
  return result.winnerId === playerId ? "playerAWins" : "playerBWins";
}

export interface FinalizeMatchOutcome {
  result: MatchResult;
  /** Per-player rating before/after, or null for an aborted match (no rating change). */
  ratings: Record<PlayerId, { before: number; after: number }> | null;
}

/** Reconstructs the outcome from what's already persisted — used when finalizeMatch loses the idempotency race below. */
async function readPersistedOutcome(db: Db, matchId: string, playerAId: PlayerId, playerBId: PlayerId): Promise<FinalizeMatchOutcome> {
  const match = await db.match.findUniqueOrThrow({
    where: { id: matchId },
    include: { participants: true },
  });

  const result: MatchResult = {
    status: (match.resultStatus as MatchResult["status"] | null) ?? "aborted",
    reason: match.resultReason ?? "unknown",
    ...(match.winnerId ? { winnerId: match.winnerId } : {}),
  };

  const participantA = match.participants.find((p) => p.userId === playerAId);
  const participantB = match.participants.find((p) => p.userId === playerBId);
  const ratings =
    participantA?.ratingAfter != null && participantB?.ratingAfter != null
      ? {
          [playerAId]: { before: participantA.ratingBefore, after: participantA.ratingAfter },
          [playerBId]: { before: participantB.ratingBefore, after: participantB.ratingAfter },
        }
      : null;

  return { result, ratings };
}

/**
 * Persists a match's outcome and (unless aborted) runs the Glicko-2 rating
 * update for both players, all inside one transaction — the match row,
 * both MatchParticipant rows, and both Rating rows either all change or none
 * do. `playerIds` must have exactly two entries — Phase 1 games are 1v1.
 *
 * Idempotent: finalizing the same matchId twice (a duplicate trigger, a race
 * between two code paths) only applies the rating change once — the
 * conditional `status: "ACTIVE"` update below is the guard, since only the
 * caller that actually flips it out of ACTIVE proceeds to touch ratings.
 */
export async function finalizeMatch(
  matchId: string,
  gameId: GameId,
  playerIds: [PlayerId, PlayerId],
  result: MatchResult,
  finalState: unknown,
): Promise<FinalizeMatchOutcome> {
  const [playerAId, playerBId] = playerIds;
  const nextStatus = result.status === "aborted" ? "ABORTED" : "COMPLETED";

  const { claimed, outcome } = await prisma.$transaction(async (tx) => {
    const claim = await tx.match.updateMany({
      where: { id: matchId, status: "ACTIVE" },
      data: {
        status: nextStatus,
        completedAt: new Date(),
        resultStatus: result.status,
        resultReason: result.reason,
        winnerId: result.winnerId ?? null,
        finalState: finalState as Prisma.InputJsonValue,
      },
    });

    if (claim.count === 0) {
      return { claimed: false, outcome: await readPersistedOutcome(tx, matchId, playerAId, playerBId) };
    }

    if (result.status === "aborted") {
      return { claimed: true, outcome: { result, ratings: null } satisfies FinalizeMatchOutcome };
    }

    const match = await tx.match.findUniqueOrThrow({ where: { id: matchId }, select: { mode: true } });
    const [ratingA, ratingB] = await Promise.all([
      getOrCreateRating(playerAId, gameId, match.mode, tx),
      getOrCreateRating(playerBId, gameId, match.mode, tx),
    ]);
    const updated = await applyAndPersistMatchResult(playerAId, playerBId, gameId, match.mode, outcomeFor(result, playerAId), tx);

    await Promise.all([
      tx.matchParticipant.update({
        where: { matchId_userId: { matchId, userId: playerAId } },
        data: {
          ratingAfter: updated.playerA.rating,
          deviationAfter: updated.playerA.deviation,
          scoreForRating: result.status === "draw" ? 0.5 : result.winnerId === playerAId ? 1 : 0,
        },
      }),
      tx.matchParticipant.update({
        where: { matchId_userId: { matchId, userId: playerBId } },
        data: {
          ratingAfter: updated.playerB.rating,
          deviationAfter: updated.playerB.deviation,
          scoreForRating: result.status === "draw" ? 0.5 : result.winnerId === playerBId ? 1 : 0,
        },
      }),
    ]);

    const outcome: FinalizeMatchOutcome = {
      result,
      ratings: {
        [playerAId]: { before: ratingA.rating, after: updated.playerA.rating },
        [playerBId]: { before: ratingB.rating, after: updated.playerB.rating },
      },
    };
    return { claimed: true, outcome };
  });

  if (claimed) {
    await Promise.all([releaseSession(gameId, playerAId), releaseSession(gameId, playerBId)]);
  }

  return outcome;
}

/**
 * Runs at server startup. A Match row still ACTIVE at boot belonged to a
 * previous process — its in-memory Room is gone, so it can never receive
 * another move or complete normally. Marking it ABORTED (no rating change)
 * keeps match history honest and frees both players' session locks, which
 * would otherwise block them from queueing again until the lock's TTL expires.
 */
export async function abortStaleActiveMatches(): Promise<void> {
  const stale = await prisma.match.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, gameId: true, participants: { select: { userId: true } } },
  });

  for (const match of stale) {
    await prisma.match.update({
      where: { id: match.id },
      data: {
        status: "ABORTED",
        completedAt: new Date(),
        resultStatus: "aborted",
        resultReason: "server-restart",
      },
    });
    await Promise.all(match.participants.map((p) => releaseSession(match.gameId as GameId, p.userId)));
  }

  if (stale.length > 0) {
    console.log(`Aborted ${stale.length} stale ACTIVE match(es) left over from a previous server run.`);
  }
}

export { getOrCreateRating };
