import {
  GameRuleViolation,
  type GameEngine,
  type MatchResult,
  type MoveOutcome,
  type PlayerId,
  type WordleMove,
  type WordlePlayerState,
  type WordleState,
  type WordleStateView,
} from "@smart-rot/shared-types";
import { evaluateGuess } from "./evaluate-guess.js";
import { WORDLE_ANSWERS } from "./word-lists/answers.js";
import { VALID_GUESSES } from "./word-lists/valid-guesses.js";
import { pickIndex } from "../util/seeded-random.js";

const WORD_LENGTH = 5;
const MAX_GUESSES = 6;

const VALID_GUESSES_SET = new Set<string>(VALID_GUESSES);

function buildScores(players: [PlayerId, WordlePlayerState][]): Record<PlayerId, number> {
  const scores: Record<PlayerId, number> = {};
  for (const [id, state] of players) {
    scores[id] = state.solved ? state.guesses.length : MAX_GUESSES + 1;
  }
  return scores;
}

export const wordleEngine: GameEngine<WordleState, WordleMove> = {
  gameId: "wordle",

  generateInitialState(seed, playerIds) {
    const answer = WORDLE_ANSWERS[pickIndex(seed, WORDLE_ANSWERS.length)]!;
    const players: Record<PlayerId, WordlePlayerState> = {};
    for (const id of playerIds) {
      players[id] = { guesses: [], solved: false };
    }
    return {
      answer,
      wordLength: WORD_LENGTH,
      maxGuesses: MAX_GUESSES,
      players,
      startedAt: Date.now(),
    };
  },

  validateMove(state, move, playerId) {
    if (move.type !== "guess") {
      throw new GameRuleViolation(`Unknown move type: ${(move as { type: string }).type}`);
    }
    const playerState = state.players[playerId];
    if (!playerState) {
      throw new GameRuleViolation("Player is not part of this match");
    }
    if (playerState.solved) {
      throw new GameRuleViolation("Player has already solved the puzzle");
    }
    if (playerState.guesses.length >= state.maxGuesses) {
      throw new GameRuleViolation("Player has no guesses remaining");
    }
    const word = move.word.toLowerCase();
    if (word.length !== state.wordLength) {
      throw new GameRuleViolation(`Guess must be ${state.wordLength} letters`);
    }
    if (!VALID_GUESSES_SET.has(word)) {
      throw new GameRuleViolation(`"${move.word}" is not a recognized word`);
    }
  },

  applyMove(state, move, playerId): MoveOutcome<WordleState> {
    wordleEngine.validateMove(state, move, playerId);
    const word = move.word.toLowerCase();
    const letters = evaluateGuess(word, state.answer);
    const solved = word === state.answer;
    const previousPlayerState = state.players[playerId]!;

    const nextPlayerState: WordlePlayerState = {
      guesses: [...previousPlayerState.guesses, { guess: word, letters }],
      solved,
      ...(solved ? { finishedAt: Date.now() } : {}),
    };

    return {
      state: {
        ...state,
        players: {
          ...state.players,
          [playerId]: nextPlayerState,
        },
      },
    };
  },

  isTerminal(state) {
    const players = Object.values(state.players);
    const anySolved = players.some((p) => p.solved);
    const allExhausted = players.every((p) => p.solved || p.guesses.length >= state.maxGuesses);
    return anySolved || allExhausted;
  },

  getResult(state): MatchResult {
    const entries = Object.entries(state.players) as [PlayerId, WordlePlayerState][];
    const solved = entries.filter(([, p]) => p.solved);

    if (solved.length > 0) {
      solved.sort((a, b) => (a[1].finishedAt ?? Infinity) - (b[1].finishedAt ?? Infinity));
      const fastest = solved[0]!;
      const isTie = solved.length > 1 && solved[1]![1].finishedAt === fastest[1].finishedAt;
      if (isTie) {
        return { status: "draw", reason: "simultaneous-solve", scores: buildScores(entries) };
      }
      return { status: "win", winnerId: fastest[0], reason: "solved", scores: buildScores(entries) };
    }

    return { status: "draw", reason: "no-solve", scores: buildScores(entries) };
  },

  serializeStateForPlayer(state, playerId): WordleStateView {
    const self = state.players[playerId];
    if (!self) {
      throw new GameRuleViolation("Player is not part of this match");
    }
    const opponentEntry = Object.entries(state.players).find(([id]) => id !== playerId);
    const opponent = opponentEntry?.[1];
    const terminal = wordleEngine.isTerminal(state);

    return {
      wordLength: state.wordLength,
      maxGuesses: state.maxGuesses,
      self: {
        guesses: self.guesses,
        solved: self.solved,
        finishedAt: self.finishedAt,
        guessesRemaining: state.maxGuesses - self.guesses.length,
      },
      opponent: {
        guessCount: opponent?.guesses.length ?? 0,
        solved: opponent?.solved ?? false,
        finishedAt: opponent?.finishedAt,
      },
      ...(terminal ? { revealedAnswer: state.answer } : {}),
    };
  },
};
