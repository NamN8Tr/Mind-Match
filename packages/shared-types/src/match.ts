import type { GameId, MatchResult, PlayerId } from "./game-engine.js";

export type MatchStatus = "active" | "completed" | "aborted";

export interface MatchPlayer {
  userId: PlayerId;
  isBot: boolean;
  /** Rating going into the match, captured for history/display even after later matches change it. */
  ratingBefore: number;
  ratingDeviationBefore: number;
}

export interface Match {
  id: string;
  gameId: GameId;
  mode: string;
  seed: string;
  status: MatchStatus;
  players: MatchPlayer[];
  createdAt: string;
  completedAt?: string;
  result?: MatchResult;
}
