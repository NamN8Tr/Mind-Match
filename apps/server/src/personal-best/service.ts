import type { GameId, TimedPersonalBest } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import type { Db } from "../rating/service.js";

function toDomain(row: { gameId: string; mode: string; bestTimeMs: number; achievedAt: Date }): TimedPersonalBest {
  return {
    gameId: row.gameId,
    mode: row.mode,
    bestTimeMs: row.bestTimeMs,
    achievedAt: row.achievedAt.toISOString(),
  };
}

export async function getPersonalBests(userId: string, db: Db = prisma): Promise<TimedPersonalBest[]> {
  const rows = await db.personalBest.findMany({ where: { userId }, orderBy: { achievedAt: "desc" } });
  return rows.map(toDomain);
}

export async function recordTimedPersonalBest(
  userId: string,
  gameId: GameId,
  mode: string,
  elapsedMs: number,
): Promise<{ personalBest: TimedPersonalBest; improved: boolean }> {
  const roundedElapsedMs = Math.max(1, Math.round(elapsedMs));
  const achievedAt = new Date();

  try {
    const created = await prisma.personalBest.create({
      data: { userId, gameId, mode, bestTimeMs: roundedElapsedMs, achievedAt },
    });
    return { personalBest: toDomain(created), improved: true };
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") throw error;
  }

  const updated = await prisma.personalBest.updateMany({
    where: { userId, gameId, mode, bestTimeMs: { gt: roundedElapsedMs } },
    data: { bestTimeMs: roundedElapsedMs, achievedAt },
  });
  const personalBest = await prisma.personalBest.findUniqueOrThrow({
    where: { userId_gameId_mode: { userId, gameId, mode } },
  });
  return { personalBest: toDomain(personalBest), improved: updated.count > 0 };
}
