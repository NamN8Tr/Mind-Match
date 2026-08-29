import type { PlayerId } from "../game-engine.js";

export const SPIDER_MODES = ["1-suit", "2-suit", "3-suit", "4-suit"] as const;
export type SpiderMode = (typeof SPIDER_MODES)[number];
export type SpiderSuit = "spades" | "hearts" | "diamonds" | "clubs";

export interface SpiderCard {
  /** Unique even though a Spider deck contains repeated ranks and suits. */
  id: string;
  /** Ace is 1, Jack 11, Queen 12, King 13. */
  rank: number;
  suit: SpiderSuit;
  faceUp: boolean;
}

export interface SpiderUndoSnapshot {
  columns: SpiderCard[][];
  stock: SpiderCard[][];
  completedSuits: SpiderSuit[];
}

export interface SpiderPlayerState {
  /** Cards are ordered bottom-to-top in every column. */
  columns: SpiderCard[][];
  /** Five ten-card batches, ordered by which batch is dealt next. */
  stock: SpiderCard[][];
  completedSuits: SpiderSuit[];
  completedRuns: number;
  /** Counts accepted board actions, including draws and take-backs. */
  moveCount: number;
  resetCount: number;
  solved: boolean;
  undoStack: SpiderUndoSnapshot[];
  finishedAt?: number;
}

export interface SpiderPlayerView extends Omit<SpiderPlayerState, "undoStack"> {
  canUndo: boolean;
}

export interface SpiderState {
  mode: SpiderMode;
  targetRuns: number;
  /** Used by the server-authoritative reset move; identical for every player. */
  initialColumns: SpiderCard[][];
  initialStock: SpiderCard[][];
  players: Record<PlayerId, SpiderPlayerState>;
}

export type SpiderMove =
  | {
      type: "move";
      fromColumn: number;
      cardIndex: number;
      toColumn: number;
    }
  | { type: "draw" }
  | { type: "undo" }
  | { type: "reset" };

export interface SpiderOpponentView {
  completedRuns: number;
  moveCount: number;
  remainingCards: number;
  remainingDeals: number;
  resetCount: number;
  solved: boolean;
  finishedAt?: number;
}

export interface SpiderStateView {
  mode: SpiderMode;
  targetRuns: number;
  self: SpiderPlayerView;
  opponent: SpiderOpponentView;
}
