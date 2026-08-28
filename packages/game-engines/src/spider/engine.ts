import {
  GameRuleViolation,
  type GameEngine,
  type MatchResult,
  type MoveOutcome,
  type PlayerId,
  type SpiderCard,
  type SpiderMove,
  type SpiderPlayerState,
  type SpiderState,
  type SpiderStateView,
} from "@smart-rot/shared-types";
import { createSeededRandom } from "../util/seeded-random.js";

export const SPIDER_COLUMN_COUNT = 8;
export const SPIDER_TARGET_RUNS = 4;
const CARDS_PER_RUN = 13;
const SCRAMBLE_CHUNKS_PER_RUN = 4;

function cloneColumns(columns: SpiderCard[][]): SpiderCard[][] {
  return columns.map((column) => column.map((card) => ({ ...card })));
}

function shuffledColumnIndexes(random: () => number): number[] {
  const indexes = Array.from({ length: SPIDER_COLUMN_COUNT }, (_, index) => index);
  for (let index = indexes.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [indexes[index], indexes[other]] = [indexes[other]!, indexes[index]!];
  }
  return indexes;
}

/**
 * Creates a deterministic deal by starting with four completed runs, splitting
 * each into several chunks, and recording the legal moves that rebuild them.
 * Replaying `solution` therefore proves that every emitted board is solvable.
 */
export function generateSolvableSpiderDeal(seed: string): { columns: SpiderCard[][]; solution: SpiderMove[] } {
  const random = createSeededRandom(seed);
  const columns: SpiderCard[][] = Array.from({ length: SPIDER_COLUMN_COUNT }, () => []);
  const positions = shuffledColumnIndexes(random);
  const reverseMoves: SpiderMove[] = [];

  for (let run = 0; run < SPIDER_TARGET_RUNS; run += 1) {
    const sourceColumn = positions[run * 2]!;
    const targetColumn = positions[run * 2 + 1]!;
    columns[sourceColumn] = Array.from({ length: CARDS_PER_RUN }, (_, index) => ({
      id: `run-${run}-rank-${CARDS_PER_RUN - index}`,
      rank: CARDS_PER_RUN - index,
      suit: "spades" as const,
    }));

    for (let chunk = 0; chunk < SCRAMBLE_CHUNKS_PER_RUN; chunk += 1) {
      const source = columns[sourceColumn]!;
      const chunksLeft = SCRAMBLE_CHUNKS_PER_RUN - chunk - 1;
      const maxChunkSize = Math.min(3, source.length - chunksLeft - 1);
      const chunkSize = 1 + Math.floor(random() * maxChunkSize);
      const cardIndex = source.length - chunkSize;
      const targetStartIndex = columns[targetColumn]!.length;
      const moved = source.splice(cardIndex);
      columns[targetColumn]!.push(...moved);
      reverseMoves.push({ type: "move", fromColumn: targetColumn, cardIndex: targetStartIndex, toColumn: sourceColumn });
    }
  }

  return { columns, solution: reverseMoves.reverse() };
}

function playerFor(state: SpiderState, playerId: PlayerId): SpiderPlayerState {
  const player = state.players[playerId];
  if (!player) throw new GameRuleViolation("Player is not part of this match");
  return player;
}

function isDescendingRun(cards: SpiderCard[]): boolean {
  return cards.every((card, index) => index === 0 || cards[index - 1]!.rank === card.rank + 1);
}

function removeCompletedRuns(columns: SpiderCard[][]): number {
  let removed = 0;
  for (const column of columns) {
    while (column.length >= CARDS_PER_RUN) {
      const candidate = column.slice(-CARDS_PER_RUN);
      const isComplete = candidate.every((card, index) => card.rank === CARDS_PER_RUN - index);
      if (!isComplete) break;
      column.splice(-CARDS_PER_RUN);
      removed += 1;
    }
  }
  return removed;
}

function scoresFor(state: SpiderState): Record<PlayerId, number> {
  return Object.fromEntries(
    Object.entries(state.players).map(([id, player]) => [id, player.completedRuns * 10_000 - player.moveCount]),
  );
}

export const spiderSpeedEngine: GameEngine<SpiderState, SpiderMove> = {
  gameId: "spider",

  generateInitialState(seed, playerIds) {
    const { columns } = generateSolvableSpiderDeal(seed);
    const players: Record<PlayerId, SpiderPlayerState> = {};
    for (const playerId of playerIds) {
      players[playerId] = {
        columns: cloneColumns(columns),
        completedRuns: 0,
        moveCount: 0,
        resetCount: 0,
        solved: false,
      };
    }
    return {
      mode: "speed",
      targetRuns: SPIDER_TARGET_RUNS,
      initialColumns: cloneColumns(columns),
      players,
    };
  },

  validateMove(state, move, playerId) {
    const player = playerFor(state, playerId);
    if (player.solved) throw new GameRuleViolation("You have already completed this board");

    if (move.type === "reset") {
      if (player.moveCount === 0) throw new GameRuleViolation("The board is already at its starting position");
      return;
    }
    if (move.type !== "move") {
      throw new GameRuleViolation(`Unknown move type: ${(move as { type: string }).type}`);
    }

    const { fromColumn, cardIndex, toColumn } = move;
    if (![fromColumn, cardIndex, toColumn].every(Number.isInteger)) {
      throw new GameRuleViolation("Move positions must be whole numbers");
    }
    if (fromColumn < 0 || fromColumn >= state.initialColumns.length || toColumn < 0 || toColumn >= state.initialColumns.length) {
      throw new GameRuleViolation("Column is outside the board");
    }
    if (fromColumn === toColumn) throw new GameRuleViolation("Choose a different destination column");

    const source = player.columns[fromColumn]!;
    const target = player.columns[toColumn]!;
    if (cardIndex < 0 || cardIndex >= source.length) throw new GameRuleViolation("That card is no longer available");

    const movingCards = source.slice(cardIndex);
    if (!isDescendingRun(movingCards)) throw new GameRuleViolation("Only a descending stack can move together");

    const movingRank = movingCards[0]!.rank;
    const targetRank = target.at(-1)?.rank;
    if (targetRank !== undefined && targetRank !== movingRank + 1) {
      throw new GameRuleViolation("Place the stack on the next higher card");
    }
  },

  applyMove(state, move, playerId): MoveOutcome<SpiderState> {
    this.validateMove(state, move, playerId);
    const previous = playerFor(state, playerId);
    let nextPlayer: SpiderPlayerState;

    if (move.type === "reset") {
      nextPlayer = {
        columns: cloneColumns(state.initialColumns),
        completedRuns: 0,
        moveCount: previous.moveCount + 1,
        resetCount: previous.resetCount + 1,
        solved: false,
      };
    } else {
      const columns = cloneColumns(previous.columns);
      const moved = columns[move.fromColumn]!.splice(move.cardIndex);
      columns[move.toColumn]!.push(...moved);
      const completedRuns = previous.completedRuns + removeCompletedRuns(columns);
      const solved = completedRuns === state.targetRuns;
      nextPlayer = {
        columns,
        completedRuns,
        moveCount: previous.moveCount + 1,
        resetCount: previous.resetCount,
        solved,
        ...(solved ? { finishedAt: Date.now() } : {}),
      };
    }

    return {
      state: {
        ...state,
        players: { ...state.players, [playerId]: nextPlayer },
      },
    };
  },

  isTerminal(state) {
    return Object.values(state.players).some((player) => player.solved);
  },

  getResult(state): MatchResult {
    const solved = Object.entries(state.players)
      .filter(([, player]) => player.solved)
      .sort((a, b) => (a[1].finishedAt ?? Infinity) - (b[1].finishedAt ?? Infinity));
    if (solved.length === 0) return { status: "draw", reason: "no-solve", scores: scoresFor(state) };
    if (solved.length > 1 && solved[0]![1].finishedAt === solved[1]![1].finishedAt) {
      return { status: "draw", reason: "simultaneous-solve", scores: scoresFor(state) };
    }
    return { status: "win", winnerId: solved[0]![0], reason: "solved", scores: scoresFor(state) };
  },

  getTimeoutResult(state): MatchResult {
    return { status: "draw", reason: "timeout", scores: scoresFor(state) };
  },

  serializeStateForPlayer(state, playerId): SpiderStateView {
    const self = playerFor(state, playerId);
    const opponent = Object.entries(state.players).find(([id]) => id !== playerId)?.[1];
    return {
      mode: "speed",
      targetRuns: state.targetRuns,
      self: {
        ...self,
        columns: cloneColumns(self.columns),
      },
      opponent: {
        completedRuns: opponent?.completedRuns ?? 0,
        moveCount: opponent?.moveCount ?? 0,
        remainingCards: opponent?.columns.reduce((total, column) => total + column.length, 0) ?? state.targetRuns * CARDS_PER_RUN,
        resetCount: opponent?.resetCount ?? 0,
        solved: opponent?.solved ?? false,
        finishedAt: opponent?.finishedAt,
      },
    };
  },
};
