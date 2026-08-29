import {
  GameRuleViolation,
  type GameEngine,
  type MatchResult,
  type MoveOutcome,
  type PlayerId,
  type SpiderCard,
  type SpiderMove,
  type SpiderMode,
  type SpiderPlayerState,
  type SpiderState,
  type SpiderStateView,
  type SpiderSuit,
  type SpiderUndoSnapshot,
} from "@smart-rot/shared-types";
import { createSeededRandom } from "../util/seeded-random.js";

export const SPIDER_COLUMN_COUNT = 10;
export const SPIDER_TARGET_RUNS = 8;
export const SPIDER_STOCK_DEALS = 5;
const CARDS_PER_RUN = 13;
const SUITS: SpiderSuit[] = ["spades", "hearts", "diamonds", "clubs"];

interface SpiderDeal {
  columns: SpiderCard[][];
  stock: SpiderCard[][];
  /** A server-legal solve path proving that the generated deal is solvable. */
  solution: SpiderMove[];
}

interface OpeningCandidate {
  columns: SpiderCard[][];
  revealMoves: SpiderMove[];
  legalMoves: number;
  sameSuitMoves: number;
  offSuitMoves: number;
  movableSources: number;
  sameSuitSources: number;
  orderedPairs: number;
}

interface CompletionPlan {
  run: number;
  target: number;
  baseLength: number;
  source: number;
}

const COMPLETION_RESTORE_PLAN: CompletionPlan[] = [
  { run: 4, target: 5, baseLength: 7, source: 9 },
  { run: 3, target: 4, baseLength: 9, source: 9 },
  { run: 6, target: 7, baseLength: 9, source: 5 },
  { run: 5, target: 6, baseLength: 11, source: 4 },
  { run: 7, target: 8, baseLength: 11, source: 7 },
  { run: 0, target: 1, baseLength: 11, source: 0 },
  { run: 1, target: 2, baseLength: 11, source: 0 },
  { run: 2, target: 3, baseLength: 11, source: 0 },
];

function cloneColumns(columns: SpiderCard[][]): SpiderCard[][] {
  return columns.map((column) => column.map((card) => ({ ...card })));
}

function cloneStock(stock: SpiderCard[][]): SpiderCard[][] {
  return stock.map((batch) => batch.map((card) => ({ ...card })));
}

function snapshotPlayer(player: SpiderPlayerState): SpiderUndoSnapshot {
  return {
    columns: cloneColumns(player.columns),
    stock: cloneStock(player.stock),
    completedSuits: [...player.completedSuits],
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const other = Math.floor(random() * (index + 1));
    [shuffled[index], shuffled[other]] = [shuffled[other]!, shuffled[index]!];
  }
  return shuffled;
}

function suitsForMode(mode: SpiderMode, random: () => number): SpiderSuit[] {
  const suitCount = Number(mode[0]);
  return shuffle(
    Array.from({ length: SPIDER_TARGET_RUNS }, (_, run) => SUITS[run % suitCount]!),
    random,
  );
}

function mapMoveColumns(move: SpiderMove, oldToNew: number[]): SpiderMove {
  if (move.type !== "move") return move;
  return {
    ...move,
    fromColumn: oldToNew[move.fromColumn]!,
    toColumn: oldToNew[move.toColumn]!,
  };
}

function scoreOpening(
  columns: SpiderCard[][],
): Pick<OpeningCandidate, "legalMoves" | "sameSuitMoves" | "offSuitMoves" | "movableSources" | "sameSuitSources" | "orderedPairs"> {
  const tops = columns.map((column) => column.at(-1));
  let legalMoves = 0;
  let sameSuitMoves = 0;
  const movableSources = new Set<number>();
  const sameSuitSources = new Set<number>();
  const orderedPairs = columns.reduce(
    (total, column) => total + column.slice(1).filter((card, index) => {
      const cardBelow = column[index]!;
      return cardBelow.rank === card.rank + 1 && cardBelow.suit === card.suit;
    }).length,
    0,
  );
  for (let source = 0; source < tops.length; source += 1) {
    for (let target = 0; target < tops.length; target += 1) {
      if (source === target) continue;
      const moving = tops[source];
      const destination = tops[target];
      if (!moving || !destination || destination.rank !== moving.rank + 1) continue;
      legalMoves += 1;
      movableSources.add(source);
      if (moving.suit === destination.suit) {
        sameSuitMoves += 1;
        sameSuitSources.add(source);
      }
    }
  }
  return {
    legalMoves,
    sameSuitMoves,
    offSuitMoves: legalMoves - sameSuitMoves,
    movableSources: movableSources.size,
    sameSuitSources: sameSuitSources.size,
    orderedPairs,
  };
}

function compareOpenings(left: OpeningCandidate, right: OpeningCandidate): number {
  return left.sameSuitSources - right.sameSuitSources ||
    left.orderedPairs - right.orderedPairs ||
    right.offSuitMoves - left.offSuitMoves ||
    right.movableSources - left.movableSources ||
    right.revealMoves.length - left.revealMoves.length ||
    left.sameSuitMoves - right.sameSuitMoves ||
    right.legalMoves - left.legalMoves;
}

function buildOpeningFromTransfers(
  baseColumns: SpiderCard[][],
  chain: number[],
  transferCounts: number[],
  hideCoveredCards = true,
): OpeningCandidate | null {
  const columns = cloneColumns(baseColumns);
  const revealMoves: SpiderMove[] = [];
  for (let step = 0; step < transferCounts.length; step += 1) {
    const recipient = chain[step]!;
    const donor = chain[step + 1]!;
    for (let transfer = 0; transfer < transferCounts[step]!; transfer += 1) {
      const donorColumn = columns[donor]!;
      const moved = donorColumn.at(-1);
      const exposed = donorColumn.at(-2);
      if (
        !moved ||
        !moved.faceUp ||
        (exposed && (!exposed.faceUp || exposed.rank !== moved.rank + 1 || exposed.suit !== moved.suit))
      ) {
        return null;
      }
      donorColumn.pop();
      const covered = columns[recipient]!.at(-1);
      if (covered && hideCoveredCards) covered.faceUp = false;
      const cardIndex = columns[recipient]!.length;
      columns[recipient]!.push(moved);
      revealMoves.push({ type: "move", fromColumn: recipient, cardIndex, toColumn: donor });
    }
  }

  if (hideCoveredCards) {
    for (const column of columns) {
      column.forEach((card, index) => {
        card.faceUp = index === column.length - 1;
      });
    }
  }
  return { columns, revealMoves, ...scoreOpening(columns) };
}

function buildOpeningCandidate(
  baseColumns: SpiderCard[][],
  chain: number[],
  targetLengths: number[],
  hideCoveredCards = true,
): OpeningCandidate | null {
  const transferCounts: number[] = [];
  let prefixDeficit = 0;
  for (let step = 0; step < chain.length - 1; step += 1) {
    const columnIndex = chain[step]!;
    prefixDeficit += targetLengths[columnIndex]! - baseColumns[columnIndex]!.length;
    if (prefixDeficit < 0) return null;
    transferCounts.push(prefixDeficit);
  }
  const lastColumn = chain.at(-1)!;
  if (prefixDeficit + targetLengths[lastColumn]! - baseColumns[lastColumn]!.length !== 0) return null;

  const candidate = buildOpeningFromTransfers(baseColumns, chain, transferCounts, hideCoveredCards);
  if (!candidate || candidate.columns.some((column, index) => column.length !== targetLengths[index])) return null;
  return candidate;
}

function legacyOpening(baseColumns: SpiderCard[][]): OpeningCandidate | null {
  return buildOpeningFromTransfers(
    baseColumns,
    [0, 9, 1, 2, 3, 4, 5, 6, 7, 8],
    [5, 6, 6, 6, 5, 4, 3, 2, 1],
  );
}

function harderOpenings(
  baseColumns: SpiderCard[][],
  random: () => number,
  targetSameSuitSources: number,
): OpeningCandidate[] {
  const indices = Array.from({ length: SPIDER_COLUMN_COUNT }, (_, index) => index);
  const candidates = new Map<string, OpeningCandidate>();
  let targetCandidateCount = 0;

  for (let attempt = 0; attempt < 32_768 && targetCandidateCount < 128; attempt += 1) {
    const chain = shuffle(indices, random);
    const sixCardColumns = new Set(shuffle(indices, random).slice(0, 4));
    const targetLengths = indices.map((index) => sixCardColumns.has(index) ? 6 : 5);
    const candidate = buildOpeningCandidate(baseColumns, chain, targetLengths);
    if (!candidate || candidate.legalMoves === 0) continue;
    const key = candidate.columns.map((column) => column.at(-1)!.id).join(":");
    if (!candidates.has(key) && candidate.sameSuitSources <= targetSameSuitSources) {
      targetCandidateCount += 1;
    }
    candidates.set(key, candidate);
  }

  return [...candidates.values()].sort(compareOpenings);
}

function stockDifficultyPenalty(columns: SpiderCard[][], stock: SpiderCard[][]): number {
  const simulated = cloneColumns(columns);
  let penalty = 0;

  stock.forEach((batch, dealIndex) => {
    const earlyDealWeight = SPIDER_STOCK_DEALS - dealIndex;
    batch.forEach((card, columnIndex) => {
      const previousTop = simulated[columnIndex]!.at(-1);
      if (previousTop?.rank === card.rank + 1) {
        penalty += earlyDealWeight * (previousTop.suit === card.suit ? 18 : 5);
      }
      simulated[columnIndex]!.push({ ...card, faceUp: true });
    });

    const score = scoreOpening(simulated);
    penalty += earlyDealWeight * (
      score.sameSuitSources * 14 +
      score.sameSuitMoves * 7 +
      score.offSuitMoves * 2 +
      score.orderedPairs
    );
  });

  return penalty;
}

/**
 * Generates a full 104-card Spider deal with ten tableau columns, five stock
 * deals, hidden cards, and a known legal solution. The topology is built in
 * reverse from eight completed runs; a seeded column permutation and shuffled
 * run suits keep identical seeds identical while still varying boards.
 */
export function generateSolvableSpiderDeal(seed: string, mode: SpiderMode = "1-suit"): SpiderDeal {
  const random = createSeededRandom(seed);
  const columns: SpiderCard[][] = Array.from({ length: SPIDER_COLUMN_COUNT }, () => []);
  const runSuits = suitsForMode(mode, random);
  const completionMoves: SpiderMove[] = [];

  for (const plan of COMPLETION_RESTORE_PLAN) {
    const suit = runSuits[plan.run]!;
    const run = Array.from({ length: CARDS_PER_RUN }, (_, index): SpiderCard => ({
      id: `${suit}-run-${plan.run}-rank-${CARDS_PER_RUN - index}`,
      rank: CARDS_PER_RUN - index,
      suit,
      faceUp: true,
    }));
    const base = run.slice(0, plan.baseLength);
    const moving = run.slice(plan.baseLength);
    const cardIndex = columns[plan.source]!.length;
    columns[plan.target]!.push(...base);
    columns[plan.source]!.push(...moving);
    completionMoves.push({
      type: "move",
      fromColumn: plan.source,
      cardIndex,
      toColumn: plan.target,
    });
  }

  const proveDeal = (
    dealColumns: SpiderCard[][],
    dealStock: SpiderCard[][],
    plannedSolution: SpiderMove[],
  ): SpiderMove[] | null => {
    const solution: SpiderMove[] = [];
    const proofColumns = cloneColumns(dealColumns);
    const proofStock = cloneStock(dealStock);

    const applyProofMove = (move: SpiderMove): boolean => {
      if (move.type === "draw") {
        if (proofColumns.some((column) => column.length === 0)) return false;
        const batch = proofStock.shift();
        if (!batch) return false;
        batch.forEach((card, columnIndex) => {
          proofColumns[columnIndex]!.push({ ...card, faceUp: true });
        });
      } else if (move.type === "move") {
        const source = proofColumns[move.fromColumn]!;
        const target = proofColumns[move.toColumn]!;
        const moving = source.slice(move.cardIndex);
        const destination = target.at(-1);
        if (
          moving.length === 0 ||
          !isDescendingRun(moving) ||
          (destination && (!destination.faceUp || destination.rank !== moving[0]!.rank + 1))
        ) {
          return false;
        }
        source.splice(move.cardIndex);
        target.push(...moving);
        const exposed = source.at(-1);
        if (exposed) exposed.faceUp = true;
      }
      removeCompletedRuns(proofColumns);
      return true;
    };

    for (let moveIndex = 0; moveIndex < plannedSolution.length; moveIndex += 1) {
      const move = plannedSolution[moveIndex]!;
      if (applyProofMove(move)) {
        solution.push({ ...move });
        continue;
      }
      return null;
    }
    for (let source = 0; source < SPIDER_COLUMN_COUNT; source += 1) {
      if (!proofColumns[source]!.some((card) => !card.faceUp)) continue;
      const buffers: number[] = [];
      while (proofColumns[source]!.some((card) => !card.faceUp)) {
        const destination = proofColumns.findIndex((column, index) => index !== source && column.length === 0);
        const cardIndex = proofColumns[source]!.findIndex((card) => card.faceUp);
        if (destination < 0 || cardIndex <= 0) return null;
        const move: SpiderMove = { type: "move", fromColumn: source, cardIndex, toColumn: destination };
        if (!applyProofMove(move)) return null;
        solution.push(move);
        buffers.push(destination);
      }
      for (const fromColumn of buffers.reverse()) {
        const move: SpiderMove = { type: "move", fromColumn, cardIndex: 0, toColumn: source };
        if (!applyProofMove(move)) return null;
        solution.push(move);
      }
    }
    if (proofStock.length !== 0 || proofColumns.some((column) => column.length !== 0)) {
      return null;
    }
    return solution;
  };

  const baseColumns = cloneColumns(columns);
  const removedBatches: SpiderCard[][] = [];
  for (let deal = 0; deal < SPIDER_STOCK_DEALS; deal += 1) {
    removedBatches.push(
      baseColumns.map((column) => {
        const card = column.pop();
        if (!card) throw new Error("Spider generator could not form a complete stock deal");
        return { ...card, faceUp: false };
      }),
    );
  }
  const stock = removedBatches.reverse();

  let selected: { opening: OpeningCandidate; solution: SpiderMove[]; penalty: number } | null = null;
  const targetSameSuitSources = mode === "1-suit" ? 2 : 1;
  const fallbackOpening = legacyOpening(baseColumns);
  const openingCandidates = [
    ...harderOpenings(baseColumns, random, targetSameSuitSources),
    ...(fallbackOpening ? [fallbackOpening] : []),
  ].sort(compareOpenings);
  for (const candidate of openingCandidates) {
    const plannedSolution: SpiderMove[] = [
      ...candidate.revealMoves.slice().reverse(),
      ...Array.from({ length: SPIDER_STOCK_DEALS }, (): SpiderMove => ({ type: "draw" })),
      ...completionMoves.slice().reverse(),
    ];
    const candidateSolution = proveDeal(candidate.columns, stock, plannedSolution);
    if (!candidateSolution) continue;
    const penalty =
      candidate.sameSuitSources * 1_000 +
      candidate.sameSuitMoves * 250 +
      candidate.legalMoves * 80 +
      candidate.orderedPairs * 25 +
      stockDifficultyPenalty(candidate.columns, stock);
    if (!selected || penalty < selected.penalty) {
      selected = { opening: candidate, solution: candidateSolution, penalty };
    }
  }
  if (!selected) throw new Error("Spider generator could not prove a solvable opening");
  const openingColumns = selected.opening.columns;
  const solution = selected.solution;

  const columnIndices = Array.from({ length: SPIDER_COLUMN_COUNT }, (_, index) => index);
  const newToOld = [
    ...shuffle(columnIndices.filter((index) => openingColumns[index]!.length === 6), random),
    ...shuffle(columnIndices.filter((index) => openingColumns[index]!.length === 5), random),
  ];
  const oldToNew = Array.from({ length: SPIDER_COLUMN_COUNT }, () => 0);
  newToOld.forEach((oldIndex, newIndex) => {
    oldToNew[oldIndex] = newIndex;
  });

  return {
    columns: newToOld.map((oldIndex) => openingColumns[oldIndex]!.map((card) => ({ ...card }))),
    stock: stock.map((batch) => newToOld.map((oldIndex) => ({ ...batch[oldIndex]! }))),
    solution: solution.map((move) => mapMoveColumns(move, oldToNew)),
  };
}

function playerFor(state: SpiderState, playerId: PlayerId): SpiderPlayerState {
  const player = state.players[playerId];
  if (!player) throw new GameRuleViolation("Player is not part of this match");
  return player;
}

function isDescendingRun(cards: SpiderCard[]): boolean {
  return cards.every(
    (card, index) =>
      card.faceUp &&
      (index === 0 ||
        (cards[index - 1]!.rank === card.rank + 1 && cards[index - 1]!.suit === card.suit)),
  );
}

function removeCompletedRuns(columns: SpiderCard[][]): SpiderSuit[] {
  const removed: SpiderSuit[] = [];
  for (const column of columns) {
    while (column.length >= CARDS_PER_RUN) {
      const candidate = column.slice(-CARDS_PER_RUN);
      const suit = candidate[0]!.suit;
      const isComplete = candidate.every(
        (card, index) => card.faceUp && card.rank === CARDS_PER_RUN - index && card.suit === suit,
      );
      if (!isComplete) break;
      column.splice(-CARDS_PER_RUN);
      removed.push(suit);
      const exposed = column.at(-1);
      if (exposed) exposed.faceUp = true;
    }
  }
  return removed;
}

function scoresFor(state: SpiderState): Record<PlayerId, number> {
  return Object.fromEntries(
    Object.entries(state.players).map(([id, player]) => [id, player.completedRuns * 10_000 - player.moveCount]),
  );
}

export function createSpiderEngine(mode: SpiderMode): GameEngine<SpiderState, SpiderMove> {
  return {
    gameId: "spider",

    generateInitialState(seed, playerIds) {
      const { columns, stock } = generateSolvableSpiderDeal(seed, mode);
      const players: Record<PlayerId, SpiderPlayerState> = {};
      for (const playerId of playerIds) {
        players[playerId] = {
          columns: cloneColumns(columns),
          stock: cloneStock(stock),
          completedSuits: [],
          completedRuns: 0,
          moveCount: 0,
          resetCount: 0,
          solved: false,
          undoStack: [],
        };
      }
      return {
        mode,
        targetRuns: SPIDER_TARGET_RUNS,
        initialColumns: cloneColumns(columns),
        initialStock: cloneStock(stock),
        players,
      };
    },

    validateMove(state, move, playerId) {
      const player = playerFor(state, playerId);
      if (player.solved) throw new GameRuleViolation("You have already completed this board");

      if (move.type === "undo") {
        if (player.undoStack.length === 0) throw new GameRuleViolation("There is nothing to take back");
        return;
      }
      if (move.type === "draw") {
        if (player.stock.length === 0) throw new GameRuleViolation("There are no sets left to draw");
        return;
      }
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
      if (
        fromColumn < 0 ||
        fromColumn >= SPIDER_COLUMN_COUNT ||
        toColumn < 0 ||
        toColumn >= SPIDER_COLUMN_COUNT
      ) {
        throw new GameRuleViolation("Column is outside the board");
      }
      if (fromColumn === toColumn) throw new GameRuleViolation("Choose a different destination column");

      const source = player.columns[fromColumn]!;
      const target = player.columns[toColumn]!;
      if (cardIndex < 0 || cardIndex >= source.length) {
        throw new GameRuleViolation("That card is no longer available");
      }

      const movingCards = source.slice(cardIndex);
      if (!isDescendingRun(movingCards)) {
        throw new GameRuleViolation("Only a face-up, same-suit descending stack can move together");
      }

      const movingRank = movingCards[0]!.rank;
      const targetCard = target.at(-1);
      if (targetCard && (!targetCard.faceUp || targetCard.rank !== movingRank + 1)) {
        throw new GameRuleViolation("Place the stack on the next higher card");
      }
    },

    applyMove(state, move, playerId): MoveOutcome<SpiderState> {
      this.validateMove(state, move, playerId);
      const previous = playerFor(state, playerId);
      let nextPlayer: SpiderPlayerState;

      if (move.type === "undo") {
        const previousBoard = previous.undoStack.at(-1)!;
        nextPlayer = {
          ...previous,
          columns: cloneColumns(previousBoard.columns),
          stock: cloneStock(previousBoard.stock),
          completedSuits: [...previousBoard.completedSuits],
          completedRuns: previousBoard.completedSuits.length,
          moveCount: previous.moveCount + 1,
          solved: false,
          undoStack: previous.undoStack.slice(0, -1),
          finishedAt: undefined,
        };
      } else if (move.type === "reset") {
        nextPlayer = {
          columns: cloneColumns(state.initialColumns),
          stock: cloneStock(state.initialStock),
          completedSuits: [],
          completedRuns: 0,
          moveCount: previous.moveCount + 1,
          resetCount: previous.resetCount + 1,
          solved: false,
          undoStack: [],
        };
      } else {
        const columns = cloneColumns(previous.columns);
        const stock = cloneStock(previous.stock);
        const undoStack = [...previous.undoStack, snapshotPlayer(previous)];
        let completedSuits = [...previous.completedSuits];

        if (move.type === "draw") {
          const batch = stock.shift()!;
          batch.forEach((card, columnIndex) => {
            columns[columnIndex]!.push({ ...card, faceUp: true });
          });
        } else {
          const moved = columns[move.fromColumn]!.splice(move.cardIndex);
          columns[move.toColumn]!.push(...moved);
          const exposed = columns[move.fromColumn]!.at(-1);
          if (exposed) exposed.faceUp = true;
        }

        completedSuits = [...completedSuits, ...removeCompletedRuns(columns)];
        const solved = completedSuits.length === state.targetRuns;
        nextPlayer = {
          columns,
          stock,
          completedSuits,
          completedRuns: completedSuits.length,
          moveCount: previous.moveCount + 1,
          resetCount: previous.resetCount,
          solved,
          undoStack,
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

    serializeStateForPersistence(state) {
      return {
        ...state,
        players: Object.fromEntries(
          Object.entries(state.players).map(([playerId, player]) => {
            const { undoStack: _undoStack, ...persistedPlayer } = player;
            return [playerId, persistedPlayer];
          }),
        ),
      };
    },

    serializeStateForPlayer(state, playerId): SpiderStateView {
      const self = playerFor(state, playerId);
      const opponent = Object.entries(state.players).find(([id]) => id !== playerId)?.[1];
      const { undoStack, ...publicSelf } = self;
      return {
        mode: state.mode,
        targetRuns: state.targetRuns,
        self: {
          ...publicSelf,
          columns: cloneColumns(self.columns),
          stock: cloneStock(self.stock),
          completedSuits: [...self.completedSuits],
          canUndo: undoStack.length > 0,
        },
        opponent: {
          completedRuns: opponent?.completedRuns ?? 0,
          moveCount: opponent?.moveCount ?? 0,
          remainingCards:
            (opponent?.columns.reduce((total, column) => total + column.length, 0) ??
              state.initialColumns.reduce((total, column) => total + column.length, 0)) +
            (opponent?.stock.reduce((total, batch) => total + batch.length, 0) ??
              state.initialStock.reduce((total, batch) => total + batch.length, 0)),
          remainingDeals: opponent?.stock.length ?? state.initialStock.length,
          resetCount: opponent?.resetCount ?? 0,
          solved: opponent?.solved ?? false,
          finishedAt: opponent?.finishedAt,
        },
      };
    },
  };
}

export const spiderOneSuitEngine = createSpiderEngine("1-suit");
export const spiderTwoSuitEngine = createSpiderEngine("2-suit");
export const spiderThreeSuitEngine = createSpiderEngine("3-suit");
export const spiderFourSuitEngine = createSpiderEngine("4-suit");
export const spiderEngines: Record<SpiderMode, GameEngine<SpiderState, SpiderMove>> = {
  "1-suit": spiderOneSuitEngine,
  "2-suit": spiderTwoSuitEngine,
  "3-suit": spiderThreeSuitEngine,
  "4-suit": spiderFourSuitEngine,
};
/** Backwards-compatible name for the original one-suit Spider engine. */
export const spiderSpeedEngine = spiderOneSuitEngine;
