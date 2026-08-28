import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth/fastify-plugin.js";
import { prisma } from "../db/prisma.js";
import { getPersonalBests } from "../personal-best/service.js";
import { getOrCreateRating } from "../rating/service.js";

const SUPPORTED_RATING_POOLS = [
  { gameId: "wordle", mode: "speed" },
  { gameId: "wordle", mode: "fewest-guesses" },
] as const;

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
      mode: p.match.mode,
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
