import type { GameId, PlayerId } from "./game-engine.js";

/**
 * A player's Glicko-2 rating for one specific game. Ratings are never blended
 * across games — each (userId, gameId) pair has its own independent rating row.
 */
export interface Glicko2Rating {
  userId: PlayerId;
  gameId: GameId;
  /** Glicko-2 rating on the familiar ~1500-centered scale (not the internal mu scale). */
  rating: number;
  /** Rating deviation: confidence interval half-width, also on the ~1500 scale. */
  deviation: number;
  /** Volatility: expected fluctuation in rating over time. */
  volatility: number;
  ratingPeriodsPlayed: number;
  updatedAt: string;
}

export type MatchOutcomeForRating = 1 | 0.5 | 0;

export interface RatingUpdateInput {
  playerRating: Glicko2Rating;
  opponentRating: Glicko2Rating;
  /** Score from playerRating's perspective: 1 = win, 0.5 = draw, 0 = loss. */
  score: MatchOutcomeForRating;
}

export const DEFAULT_GLICKO2_RATING = 1500;
export const DEFAULT_GLICKO2_DEVIATION = 350;
export const DEFAULT_GLICKO2_VOLATILITY = 0.06;
