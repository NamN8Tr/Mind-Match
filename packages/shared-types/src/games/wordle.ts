import type { PlayerId } from "../game-engine.js";

export type LetterState = "correct" | "present" | "absent";

export interface WordleGuessFeedback {
  guess: string;
  letters: LetterState[];
}

export interface WordlePlayerState {
  guesses: WordleGuessFeedback[];
  solved: boolean;
  finishedAt?: number;
}

/**
 * Both players race to solve the same puzzle (same seed -> same answer),
 * each submitting their own independent sequence of guesses. This is the
 * "shared board seed" principle applied to a race-style game rather than
 * a single shared board.
 */
export interface WordleState {
  answer: string;
  wordLength: number;
  maxGuesses: number;
  players: Record<PlayerId, WordlePlayerState>;
  startedAt: number;
}

export interface WordleMove {
  type: "guess";
  word: string;
}

export interface WordlePlayerView {
  guesses: WordleGuessFeedback[];
  solved: boolean;
  finishedAt?: number;
  guessesRemaining: number;
}

export interface WordleOpponentView {
  guessCount: number;
  solved: boolean;
  finishedAt?: number;
}

/**
 * Per-player view of WordleState. Never includes the opponent's guessed words,
 * only race progress; the answer itself is included only once the match is over.
 */
export interface WordleStateView {
  wordLength: number;
  maxGuesses: number;
  self: WordlePlayerView;
  opponent: WordleOpponentView;
  revealedAnswer?: string;
}
