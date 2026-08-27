import type { GameId, MatchResult, PlayerId } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import { applyAndPersistMatchResult, getOrCreateRating, type MatchOutcome } from "../rating/service.js";

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
export async function createPendingMatch(gameId: GameId, seed: string, players: PendingMatchPlayer[]): Promise<string> {
  const match = await prisma.match.create({
    data: {
      gameId,
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

function outcomeFor(result: MatchResult, playerId: PlayerId, opponentId: PlayerId): MatchOutcome {
  if (result.status === "draw") return "draw";
  return result.winnerId === playerId ? "playerAWins" : "playerBWins";
}

/**
 * Persists a completed match's result and runs the Glicko-2 rating update for
 * both players (skipped for aborted matches, which award no rating change).
 * `playerIds` must have exactly two entries — Phase 1 games are 1v1.
 */
export async function finalizeMatch(
  matchId: string,
  gameId: GameId,
  playerIds: [PlayerId, PlayerId],
  result: MatchResult,
  finalState: unknown,
): Promise<void> {
  const [playerAId, playerBId] = playerIds;

  if (result.status !== "aborted") {
    const updated = await applyAndPersistMatchResult(playerAId, playerBId, gameId, outcomeFor(result, playerAId, playerBId));

    await prisma.$transaction([
      prisma.match.update({
        where: { id: matchId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          resultStatus: result.status,
          resultReason: result.reason,
          winnerId: result.winnerId,
          finalState: finalState as never,
        },
      }),
      prisma.matchParticipant.update({
        where: { matchId_userId: { matchId, userId: playerAId } },
        data: {
          ratingAfter: updated.playerA.rating,
          deviationAfter: updated.playerA.deviation,
          scoreForRating: result.status === "draw" ? 0.5 : result.winnerId === playerAId ? 1 : 0,
        },
      }),
      prisma.matchParticipant.update({
        where: { matchId_userId: { matchId, userId: playerBId } },
        data: {
          ratingAfter: updated.playerB.rating,
          deviationAfter: updated.playerB.deviation,
          scoreForRating: result.status === "draw" ? 0.5 : result.winnerId === playerBId ? 1 : 0,
        },
      }),
    ]);
    return;
  }

  await prisma.match.update({
    where: { id: matchId },
    data: {
      status: "ABORTED",
      completedAt: new Date(),
      resultStatus: result.status,
      resultReason: result.reason,
      finalState: finalState as never,
    },
  });
}

export { getOrCreateRating };
