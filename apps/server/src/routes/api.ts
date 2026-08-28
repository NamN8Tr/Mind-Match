import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/fastify-plugin.js";
import { prisma } from "../db/prisma.js";
import { getPersonalBests } from "../personal-best/service.js";
import { getOrCreateRating } from "../rating/service.js";

const SUPPORTED_RATING_POOLS = [
  { gameId: "wordle", mode: "speed" },
  { gameId: "wordle", mode: "fewest-guesses" },
  { gameId: "spider", mode: "speed" },
] as const;

const matchHistoryInclude = {
  match: {
    include: {
      participants: { include: { user: { select: { id: true, displayName: true } } } },
    },
  },
} as const;

function serializeMatchParticipation(
  participation: Awaited<ReturnType<typeof getMatchParticipations>>[number],
) {
  return {
    matchId: participation.matchId,
    gameId: participation.match.gameId,
    mode: participation.match.mode,
    status: participation.match.status,
    resultStatus: participation.match.resultStatus,
    resultReason: participation.match.resultReason,
    createdAt: participation.match.createdAt,
    completedAt: participation.match.completedAt,
    ratingBefore: participation.ratingBefore,
    ratingAfter: participation.ratingAfter,
    players: participation.match.participants.map((participant) => ({
      userId: participant.userId,
      displayName: participant.user.displayName,
      isWinner: participation.match.winnerId === participant.userId,
    })),
  };
}

function getMatchParticipations(userId: string, gameId?: string, completedOnly = false, limit = 20) {
  return prisma.matchParticipant.findMany({
    where: {
      userId,
      match: {
        ...(gameId ? { gameId } : {}),
        ...(completedOnly ? { status: "COMPLETED" as const } : {}),
      },
    },
    orderBy: { match: { createdAt: "desc" } },
    take: limit,
    include: matchHistoryInclude,
  });
}

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/me", { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    const [ratings, personalBests] = await Promise.all([
      Promise.all(SUPPORTED_RATING_POOLS.map(({ gameId, mode }) => getOrCreateRating(user.id, gameId, mode))),
      getPersonalBests(user.id),
    ]);
    return {
      id: user.id,
      displayName: user.displayName,
      ratings,
      personalBests,
    };
  });

  app.patch("/api/me", { preHandler: requireAuth }, async (request, reply) => {
    const body = request.body as { username?: unknown } | null;
    const username = typeof body?.username === "string" ? body.username.trim() : "";
    if (!/^[A-Za-z0-9_-]{3,20}$/.test(username)) {
      return reply.code(400).send({
        error: "Username must be 3–20 characters using only letters, numbers, underscores, or hyphens",
      });
    }

    const user = await prisma.user.update({
      where: { id: request.currentUser!.id },
      data: { displayName: username },
    });
    return { id: user.id, displayName: user.displayName };
  });

  app.delete("/api/me", { preHandler: requireAuth }, async (request) => {
    const userId = request.currentUser!.id;
    await prisma.$transaction([
      prisma.match.updateMany({ where: { winnerId: userId }, data: { winnerId: null } }),
      prisma.user.delete({ where: { id: userId } }),
    ]);
    return { deleted: true };
  });

  app.get("/api/players/:userId", { preHandler: requireAuth }, async (request, reply) => {
    const { userId } = request.params as { userId: string };
    const player = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        displayName: true,
        isBot: true,
        createdAt: true,
        ratings: {
          orderBy: [{ gameId: "asc" }, { mode: "asc" }],
          select: {
            userId: true,
            gameId: true,
            mode: true,
            rating: true,
            deviation: true,
            volatility: true,
            ratingPeriodsPlayed: true,
            updatedAt: true,
          },
        },
        personalBests: {
          orderBy: { achievedAt: "desc" },
          select: { gameId: true, mode: true, bestTimeMs: true, achievedAt: true },
        },
      },
    });
    if (!player) return reply.code(404).send({ error: "Player not found" });

    const [participations, wins, draws, losses] = await Promise.all([
      getMatchParticipations(player.id, undefined, true),
      prisma.match.count({
        where: { status: "COMPLETED", winnerId: player.id, participants: { some: { userId: player.id } } },
      }),
      prisma.match.count({
        where: { status: "COMPLETED", resultStatus: "draw", participants: { some: { userId: player.id } } },
      }),
      prisma.match.count({
        where: {
          status: "COMPLETED",
          resultStatus: "win",
          winnerId: { not: player.id },
          participants: { some: { userId: player.id } },
        },
      }),
    ]);

    return {
      ...player,
      stats: { rankedMatches: wins + draws + losses, wins, draws, losses },
      matches: participations.map(serializeMatchParticipation),
    };
  });

  app.get("/api/matches", { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    const query = request.query as { gameId?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 20) || 20, 50);

    const participations = await getMatchParticipations(user.id, query.gameId, false, limit);
    return participations.map(serializeMatchParticipation);
  });
}
