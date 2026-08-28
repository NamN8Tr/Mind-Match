import type { PlayerId } from "../game-engine.js";

export type SpiderMode = "speed";
export type SpiderSuit = "spades";

export interface SpiderCard {
  /** Unique even though this one-suit deck contains four copies of every rank. */
  id: string;
  /** Ace is 1, Jack 11, Queen 12, King 13. */
  rank: number;
  suit: SpiderSuit;
}

export interface SpiderPlayerState {
  /** Cards are ordered bottom-to-top in every column. */
  columns: SpiderCard[][];
  completedRuns: number;
  moveCount: number;
  resetCount: number;
  solved: boolean;
  finishedAt?: number;
}

export interface SpiderState {
  mode: SpiderMode;
  targetRuns: number;
  /** Used by the server-authoritative reset move; identical for every player. */
  initialColumns: SpiderCard[][];
  players: Record<PlayerId, SpiderPlayerState>;
}

export type SpiderMove =
  | {
      type: "move";
      fromColumn: number;
      cardIndex: number;
      toColumn: number;
    }
  | { type: "reset" };

export interface SpiderOpponentView {
  completedRuns: number;
  moveCount: number;
  remainingCards: number;
  resetCount: number;
  solved: boolean;
  finishedAt?: number;
}

export interface SpiderStateView {
  mode: SpiderMode;
  targetRuns: number;
  self: SpiderPlayerState;
  opponent: SpiderOpponentView;
}
