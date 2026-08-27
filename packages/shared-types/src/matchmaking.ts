import type { GameId, PlayerId } from "./game-engine.js";

export interface QueueJoinRequest {
  userId: PlayerId;
  gameId: GameId;
}

export interface QueueTicket {
  userId: PlayerId;
  gameId: GameId;
  rating: number;
  deviation: number;
  joinedAt: number;
  /** Current half-width of the acceptable opponent-rating window; widens the longer the ticket waits. */
  searchWindow: number;
}

export interface MatchFoundNotice {
  matchId: string;
  gameId: GameId;
  opponentId: PlayerId;
  colyseusRoomId: string;
}
