import { randomUUID } from "node:crypto";
import { matchMaker, QueueRoom, type Client, type QueueClientData, type QueueMatchGroup, type QueueOptions } from "@colyseus/core";
import type { GameId, PlayerId } from "@smart-rot/shared-types";
import { verifyClerkAuthToken } from "../auth/clerk.js";
import { getOrCreateRating } from "../rating/service.js";
import { createPendingMatch } from "./match-service.js";

interface MatchmakingJoinOptions {
  authToken?: string;
}

interface MatchmakingAuth {
  userId: PlayerId;
  rank: number;
}

const BASE_RATING_WINDOW = 100;
const RATING_WINDOW_GROWTH_PER_CYCLE = 25;

/**
 * Compatible when the joining client's rating is within a window of the
 * candidate group's average rating. The window widens by RATING_WINDOW_GROWTH_PER_CYCLE
 * for every cycle (QueueRoom re-evaluates groups once per second by default) the
 * client has waited, so a long-waiting player eventually matches a less-close
 * opponent rather than waiting forever — the same expanding-window approach
 * chess.com/lichess use.
 */
function withinExpandingRatingWindow(client: QueueClientData, group: QueueMatchGroup): boolean {
  const window = BASE_RATING_WINDOW + (client.currentCycle ?? 0) * RATING_WINDOW_GROWTH_PER_CYCLE;
  return Math.abs(client.rank - group.averageRank) <= window;
}

/**
 * Builds a Colyseus QueueRoom (Colyseus's built-in matchmaking-queue room type)
 * pre-wired for one game: rating-window compatibility, Clerk auth, and creating
 * the paired match (Postgres row + game Room) once a group of two is ready.
 */
export function createMatchmakingRoom(gameId: GameId, matchRoomName: string) {
  return class MatchmakingRoom extends QueueRoom {
    override async onAuth(client: Client, options: MatchmakingJoinOptions): Promise<MatchmakingAuth> {
      const userId = await verifyClerkAuthToken(options.authToken);
      const rating = await getOrCreateRating(userId, gameId);
      return { userId, rank: rating.rating };
    }

    override onCreate(options: Partial<QueueOptions>): void {
      super.onCreate({
        ...options,
        maxPlayers: 2,
        matchRoomName,
        compare: withinExpandingRatingWindow,
        onGroupReady: (group) => this.createMatchRoom(group),
      });
    }

    override onJoin(client: Client, options: Record<string, unknown>, auth: MatchmakingAuth): void {
      super.onJoin(client, { ...options, rank: auth.rank }, auth);
    }

    private async createMatchRoom(group: QueueMatchGroup) {
      const players = await Promise.all(
        group.clients.map(async (client) => {
          const auth = client.auth as MatchmakingAuth;
          const rating = await getOrCreateRating(auth.userId, gameId);
          return { userId: auth.userId, ratingBefore: rating.rating, deviationBefore: rating.deviation };
        }),
      );

      const seed = randomUUID();
      const matchId = await createPendingMatch(gameId, seed, players);
      const playerIds = players.map((p) => p.userId) as [PlayerId, PlayerId];

      return matchMaker.createRoom(matchRoomName, { matchId, seed, playerIds });
    }
  };
}
