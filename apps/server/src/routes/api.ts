import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/fastify-plugin.js";
import { prisma } from "../db/prisma.js";
import { getOrCreateRating } from "../rating/service.js";

const SUPPORTED_GAME_IDS = ["wordle"] as const;

export async function registerApiRoutes(app: FastifyInstance): Promise<void> {
  app.get("/health", async () => ({ status: "ok" }));

  app.get("/api/me", { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    const ratings = await Promise.all(SUPPORTED_GAME_IDS.map((gameId) => getOrCreateRating(user.id, gameId)));
    return {
      id: user.id,
      displayName: user.displayName,
      ratings,
    };
  });

  app.get("/api/matches", { preHandler: requireAuth }, async (request) => {
    const user = request.currentUser!;
    const query = request.query as { gameId?: string; limit?: string };
    const limit = Math.min(Number(query.limit ?? 20) || 20, 50);

    const participations = await prisma.matchParticipant.findMany({
      where: {
        userId: user.id,
        match: query.gameId ? { gameId: query.gameId } : undefined,
      },
      orderBy: { match: { createdAt: "desc" } },
      take: limit,
      include: {
        match: {
          include: {
            participants: { include: { user: { select: { id: true, displayName: true } } } },
          },
        },
      },
    });

    return participations.map((p) => ({
      matchId: p.matchId,
      gameId: p.match.gameId,
      status: p.match.status,
      resultStatus: p.match.resultStatus,
      resultReason: p.match.resultReason,
      createdAt: p.match.createdAt,
      completedAt: p.match.completedAt,
      ratingBefore: p.ratingBefore,
      ratingAfter: p.ratingAfter,
      players: p.match.participants.map((participant) => ({
        userId: participant.userId,
        displayName: participant.user.displayName,
        isWinner: p.match.winnerId === participant.userId,
      })),
    }));
  });
}
