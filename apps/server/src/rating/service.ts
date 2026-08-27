import { createInitialRating, updateRatingsForMatch } from "@smart-rot/rating-glicko2";
import type { GameId, Glicko2Rating } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import type { Rating } from "../generated/prisma/client.js";

function toDomainRating(row: Rating): Glicko2Rating {
  return {
    userId: row.userId,
    gameId: row.gameId as GameId,
    rating: row.rating,
    deviation: row.deviation,
    volatility: row.volatility,
    ratingPeriodsPlayed: row.ratingPeriodsPlayed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrCreateRating(userId: string, gameId: GameId): Promise<Glicko2Rating> {
  const existing = await prisma.rating.findUnique({ where: { userId_gameId: { userId, gameId } } });
  if (existing) {
    return toDomainRating(existing);
  }
  const initial = createInitialRating(userId, gameId);
  const created = await prisma.rating.upsert({
    where: { userId_gameId: { userId, gameId } },
    update: {},
    create: {
      userId,
      gameId,
      rating: initial.rating,
      deviation: initial.deviation,
      volatility: initial.volatility,
    },
  });
  return toDomainRating(created);
}

export type MatchOutcome = "playerAWins" | "playerBWins" | "draw";

/** Runs the Glicko-2 update for both players and persists the new ratings. */
export async function applyAndPersistMatchResult(
  playerAId: string,
  playerBId: string,
  gameId: GameId,
  outcome: MatchOutcome,
): Promise<{ playerA: Glicko2Rating; playerB: Glicko2Rating }> {
  const [ratingA, ratingB] = await Promise.all([getOrCreateRating(playerAId, gameId), getOrCreateRating(playerBId, gameId)]);

  const updated = updateRatingsForMatch(ratingA, ratingB, outcome);

  await prisma.$transaction([
    prisma.rating.update({
      where: { userId_gameId: { userId: playerAId, gameId } },
      data: {
        rating: updated.playerA.rating,
        deviation: updated.playerA.deviation,
        volatility: updated.playerA.volatility,
        ratingPeriodsPlayed: updated.playerA.ratingPeriodsPlayed,
      },
    }),
    prisma.rating.update({
      where: { userId_gameId: { userId: playerBId, gameId } },
      data: {
        rating: updated.playerB.rating,
        deviation: updated.playerB.deviation,
        volatility: updated.playerB.volatility,
        ratingPeriodsPlayed: updated.playerB.ratingPeriodsPlayed,
      },
    }),
  ]);

  return updated;
}
