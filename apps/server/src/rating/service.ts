import { createInitialRating, updateRatingsForMatch } from "@smart-rot/rating-glicko2";
import type { GameId, Glicko2Rating } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Rating } from "../generated/prisma/client.js";

/** Either the top-level PrismaClient or an interactive-transaction client — every function here works with both. */
export type Db = typeof prisma | Prisma.TransactionClient;

function toDomainRating(row: Rating): Glicko2Rating {
  return {
    userId: row.userId,
    gameId: row.gameId as GameId,
    mode: row.mode,
    rating: row.rating,
    deviation: row.deviation,
    volatility: row.volatility,
    ratingPeriodsPlayed: row.ratingPeriodsPlayed,
    updatedAt: row.updatedAt.toISOString(),
  };
}

export async function getOrCreateRating(userId: string, gameId: GameId, mode: string, db: Db = prisma): Promise<Glicko2Rating> {
  const existing = await db.rating.findUnique({ where: { userId_gameId_mode: { userId, gameId, mode } } });
  if (existing) {
    return toDomainRating(existing);
  }
  const initial = createInitialRating(userId, gameId, mode);
  const created = await db.rating.upsert({
    where: { userId_gameId_mode: { userId, gameId, mode } },
    update: {},
    create: {
      userId,
      gameId,
      mode,
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
  mode: string,
  outcome: MatchOutcome,
  db: Db = prisma,
): Promise<{ playerA: Glicko2Rating; playerB: Glicko2Rating }> {
  const [ratingA, ratingB] = await Promise.all([
    getOrCreateRating(playerAId, gameId, mode, db),
    getOrCreateRating(playerBId, gameId, mode, db),
  ]);

  const updated = updateRatingsForMatch(ratingA, ratingB, outcome);

  await Promise.all([
    db.rating.update({
      where: { userId_gameId_mode: { userId: playerAId, gameId, mode } },
      data: {
        rating: updated.playerA.rating,
        deviation: updated.playerA.deviation,
        volatility: updated.playerA.volatility,
        ratingPeriodsPlayed: updated.playerA.ratingPeriodsPlayed,
      },
    }),
    db.rating.update({
      where: { userId_gameId_mode: { userId: playerBId, gameId, mode } },
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
