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
import verifiedBoardPool from "./verified-board-pool.json" with { type: "json" };

export const SPIDER_COLUMN_COUNT = 10;
export const SPIDER_TARGET_RUNS = 8;
export const SPIDER_STOCK_DEALS = 5;
export const SPIDER_READY_POOL_SIZE = 10;
const CARDS_PER_RUN = 13;
const MAX_ASSIGNED_DEALS = 512;
const VALID_SPIDER_SUITS = new Set<SpiderSuit>(["spades", "hearts", "diamonds", "clubs"]);

export interface SpiderVerifiedDeal {
  columns: SpiderCard[][];
  stock: SpiderCard[][];
  /** A legal win path discovered by the verifier after the random deal. */
  solution: SpiderMove[];
}

type SpiderDeal = SpiderVerifiedDeal;

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

function mapMoveColumns(move: SpiderMove, oldToNew: number[]): SpiderMove {
  return move.type === "move"
    ? { ...move, fromColumn: oldToNew[move.fromColumn]!, toColumn: oldToNew[move.toColumn]! }
    : { ...move };
}

const VERIFIED_BOARD_POOL = verifiedBoardPool as unknown as Record<SpiderMode, SpiderDeal[]>;

const READY_BOARD_QUEUES = Object.fromEntries(
  Object.entries(VERIFIED_BOARD_POOL).map(([mode, boards]) => [mode, [...boards]]),
) as Record<SpiderMode, SpiderDeal[]>;

const ASSIGNED_DEALS = new Map<string, SpiderDeal>();

function cloneDeal(deal: SpiderDeal): SpiderDeal {
  return {
    columns: cloneColumns(deal.columns),
    stock: cloneStock(deal.stock),
    solution: deal.solution.map((move) => ({ ...move })),
  };
}

function transformVerifiedDeal(selected: SpiderDeal, random: () => number): SpiderDeal {
  const oldColumnIndices = Array.from({ length: SPIDER_COLUMN_COUNT }, (_, index) => index);
  const newToOld = [
    ...shuffle(oldColumnIndices.slice(0, 4), random),
    ...shuffle(oldColumnIndices.slice(4), random),
  ];
  const oldToNew = Array.from({ length: SPIDER_COLUMN_COUNT }, () => 0);
  newToOld.forEach((oldIndex, newIndex) => {
    oldToNew[oldIndex] = newIndex;
  });

  const suits = [...new Set([...selected.columns.flat(), ...selected.stock.flat()].map((card) => card.suit))];
  const shuffledSuits = shuffle(suits, random);
  const suitMap = new Map(suits.map((suit, index) => [suit, shuffledSuits[index]!]));
  const copyCard = (card: SpiderCard): SpiderCard => ({ ...card, suit: suitMap.get(card.suit) ?? card.suit });

  return {
    columns: newToOld.map((oldIndex) => selected.columns[oldIndex]!.map(copyCard)),
    stock: selected.stock.map((batch) => newToOld.map((oldIndex) => copyCard(batch[oldIndex]!))),
    solution: selected.solution.map((move) => mapMoveColumns(move, oldToNew)),
  };
}

function rememberAssignedDeal(key: string, deal: SpiderDeal): void {
  ASSIGNED_DEALS.set(key, cloneDeal(deal));
  if (ASSIGNED_DEALS.size <= MAX_ASSIGNED_DEALS) return;
  const oldestKey = ASSIGNED_DEALS.keys().next().value as string | undefined;
  if (oldestKey) ASSIGNED_DEALS.delete(oldestKey);
}

/** Diagnostic used to ensure consuming a deal never drains the ready queue. */
export function getSpiderReadyBoardCount(mode: SpiderMode): number {
  return READY_BOARD_QUEUES[mode].length;
}

/** Returns immutable copies of the bundled fallback inventory. */
export function getBundledVerifiedSpiderDeals(mode: SpiderMode): SpiderVerifiedDeal[] {
  return VERIFIED_BOARD_POOL[mode].map(cloneDeal);
}

/**
 * Pins a pool-claimed board to a room seed before the synchronous GameEngine
 * creates state. Ranked players therefore receive one identical deal.
 */
export function registerSpiderDealAssignment(seed: string, mode: SpiderMode, deal: SpiderVerifiedDeal): void {
  rememberAssignedDeal(`${mode}:${seed}`, deal);
}

/**
 * Claims one solver-verified board from the ready queue and immediately fills
 * its slot with another solvable presentation. All transformations preserve the
 * saved proof, so neither solo nor ranked room creation waits for a search.
 */
export function generateVerifiedSpiderDeal(seed: string, mode: SpiderMode = "1-suit"): SpiderDeal {
  const assignmentKey = `${mode}:${seed}`;
  const assigned = ASSIGNED_DEALS.get(assignmentKey);
  if (assigned) return cloneDeal(assigned);

  const queue = READY_BOARD_QUEUES[mode];
  if (!queue?.length) throw new Error(`No verified Spider boards are available for ${mode}`);
  const random = createSeededRandom(`${seed}:verified-board-claim`);
  const selectedIndex = Math.floor(random() * queue.length);
  const selected = queue.splice(selectedIndex, 1)[0]!;
  const dealt = transformVerifiedDeal(selected, random);

  // Refill synchronously with an isomorphic board whose saved win path remains
  // valid. This is cheap enough to finish before generateInitialState returns.
  const refillRandom = createSeededRandom(`${seed}:verified-board-refill`);
  queue.push(transformVerifiedDeal(selected, refillRandom));
  rememberAssignedDeal(assignmentKey, dealt);
  return cloneDeal(dealt);
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
      const { columns, stock } = generateVerifiedSpiderDeal(seed, mode);
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

/**
 * Independently replays an external solver witness through the authoritative
 * rules before a generated board is allowed into server inventory.
 */
export function verifySpiderDeal(deal: SpiderVerifiedDeal, mode: SpiderMode): boolean {
  if (
    deal.columns.length !== SPIDER_COLUMN_COUNT ||
    deal.stock.length !== SPIDER_STOCK_DEALS ||
    deal.columns.some((column, index) => column.length !== (index < 4 ? 6 : 5)) ||
    deal.stock.some((batch) => batch.length !== SPIDER_COLUMN_COUNT)
  ) return false;

  const cards = [...deal.columns.flat(), ...deal.stock.flat()];
  const suitCount = Number(mode[0]);
  const suits = new Set(cards.map((card) => card.suit));
  if (
    cards.length !== 104 ||
    new Set(cards.map((card) => card.id)).size !== 104 ||
    cards.some((card) => !Number.isInteger(card.rank) || card.rank < 1 || card.rank > 13) ||
    suits.size !== suitCount ||
    [...suits].some((suit) => !VALID_SPIDER_SUITS.has(suit)) ||
    deal.columns.some((column) => column.some((card, index) => card.faceUp !== (index === column.length - 1))) ||
    deal.stock.flat().some((card) => card.faceUp)
  ) return false;

  // Unique ids and a winning path are not enough: require an exact Spider
  // deck, with every rank represented equally within each selected suit.
  const copiesPerSuit = [...suits].map((suit) => {
    const rankCounts = Array.from({ length: CARDS_PER_RUN }, (_, index) =>
      cards.filter((card) => card.suit === suit && card.rank === index + 1).length
    );
    return rankCounts.every((count) => count === rankCounts[0] && count > 0)
      ? rankCounts[0]!
      : -1;
  }).sort((left, right) => left - right);
  const expectedCopies = Array.from({ length: suitCount }, (_, index) =>
    Math.floor(SPIDER_TARGET_RUNS / suitCount) + (index < SPIDER_TARGET_RUNS % suitCount ? 1 : 0)
  ).sort((left, right) => left - right);
  if (copiesPerSuit.some((copies, index) => copies !== expectedCopies[index])) return false;

  const playerId = "solver-verifier";
  const engine = spiderEngines[mode];
  let state: SpiderState = {
    mode,
    targetRuns: SPIDER_TARGET_RUNS,
    initialColumns: cloneColumns(deal.columns),
    initialStock: cloneStock(deal.stock),
    players: {
      [playerId]: {
        columns: cloneColumns(deal.columns),
        stock: cloneStock(deal.stock),
        completedSuits: [],
        completedRuns: 0,
        moveCount: 0,
        resetCount: 0,
        solved: false,
        undoStack: [],
      },
    },
  };

  try {
    for (const move of deal.solution) {
      if (move.type === "undo" || move.type === "reset") return false;
      state = engine.applyMove(state, move, playerId).state;
    }
  } catch {
    return false;
  }
  const player = state.players[playerId]!;
  return player.solved && player.completedRuns === SPIDER_TARGET_RUNS && player.stock.length === 0 &&
    player.columns.every((column) => column.length === 0);
}
