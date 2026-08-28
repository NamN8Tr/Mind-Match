import type { GameId, TimedPersonalBest } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
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

  return prisma.$transaction(async (tx) => {
    const existing = await tx.personalBest.findUnique({
      where: { userId_gameId_mode: { userId, gameId, mode } },
    });

    if (existing && existing.bestTimeMs <= roundedElapsedMs) {
      return { personalBest: toDomain(existing), improved: false };
    }

    const achievedAt = new Date();
    const personalBest = await tx.personalBest.upsert({
      where: { userId_gameId_mode: { userId, gameId, mode } },
      create: { userId, gameId, mode, bestTimeMs: roundedElapsedMs, achievedAt },
      update: { bestTimeMs: roundedElapsedMs, achievedAt },
    });
    return { personalBest: toDomain(personalBest), improved: true };
  });
}
