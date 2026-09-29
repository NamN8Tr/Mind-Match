import assert from "node:assert/strict";
import { test } from "node:test";
import { GameRuleViolation, SPIDER_MODES, type SpiderStateView } from "@smart-rot/shared-types";
import {
  generateVerifiedSpiderDeal,
  getSpiderReadyBoardCount,
  getBundledVerifiedSpiderDeals,
  registerSpiderDealAssignment,
  SPIDER_READY_POOL_SIZE,
  spiderEngines,
  spiderOneSuitEngine,
  verifySpiderDeal,
} from "./engine.js";

test("Spider deals are deterministic, identical for both players, and independently cloned", () => {
  const first = spiderOneSuitEngine.generateInitialState("shared-board", ["p1", "p2"]);
  const second = spiderOneSuitEngine.generateInitialState("shared-board", ["p1", "p2"]);

  assert.deepEqual(first.players.p1!.columns, second.players.p1!.columns);
  assert.deepEqual(first.players.p1!.stock, second.players.p1!.stock);
  assert.deepEqual(first.players.p1!.columns, first.players.p2!.columns);
  assert.deepEqual(first.players.p1!.stock, first.players.p2!.stock);
  assert.notEqual(first.players.p1!.columns, first.players.p2!.columns);
  assert.notEqual(first.players.p1!.stock, first.players.p2!.stock);
});

test("different seeds create varied deals", () => {
  const deals = new Set(
    Array.from({ length: 12 }, (_, index) => JSON.stringify(generateVerifiedSpiderDeal(`seed-${index}`).columns)),
  );
  assert.ok(deals.size > 1);
});

test("claiming deals immediately replenishes every ready pool", () => {
  for (const mode of SPIDER_MODES) {
    assert.equal(getSpiderReadyBoardCount(mode), SPIDER_READY_POOL_SIZE);
    for (let index = 0; index < SPIDER_READY_POOL_SIZE * 2; index += 1) {
      generateVerifiedSpiderDeal(`${mode}-ready-pool-${index}`, mode);
      assert.equal(getSpiderReadyBoardCount(mode), SPIDER_READY_POOL_SIZE);
    }
  }
});

test("every bundled witness passes the same verifier used by the background worker", () => {
  for (const mode of SPIDER_MODES) {
    const deals = getBundledVerifiedSpiderDeals(mode);
    assert.equal(deals.length, SPIDER_READY_POOL_SIZE);
    for (const deal of deals) assert.equal(verifySpiderDeal(deal, mode), true);
  }
});

test("a persisted assignment is pinned to its room seed and independently cloned", () => {
  const deal = getBundledVerifiedSpiderDeals("3-suit")[4]!;
  registerSpiderDealAssignment("persisted-room", "3-suit", deal);
  const first = generateVerifiedSpiderDeal("persisted-room", "3-suit");
  const second = generateVerifiedSpiderDeal("persisted-room", "3-suit");
  assert.deepEqual(first, deal);
  assert.deepEqual(second, deal);
  assert.notEqual(first.columns, second.columns);
});

test("the pool verifier rejects a corrupted solver witness", () => {
  const deal = getBundledVerifiedSpiderDeals("1-suit")[0]!;
  deal.solution[0] = { type: "move", fromColumn: 0, cardIndex: 999, toColumn: 1 };
  assert.equal(verifySpiderDeal(deal, "1-suit"), false);
});

test("the pool verifier rejects a malformed deck even when every card id is unique", () => {
  const deal = getBundledVerifiedSpiderDeals("2-suit")[0]!;
  const changed = deal.stock[0]![0]!;
  changed.rank = changed.rank === 13 ? 12 : changed.rank + 1;
  assert.equal(verifySpiderDeal(deal, "2-suit"), false);
});

test("solvable openings look randomized while guaranteeing a small set of starting moves", () => {
  const expectedMaximums = {
    "1-suit": 8.5,
    "2-suit": 4.5,
    "3-suit": 3.5,
    "4-suit": 2.8,
  } as const;
  const expectedOrderedPairMaximums = {
    "1-suit": 30,
    "2-suit": 29,
    "3-suit": 29,
    "4-suit": 28,
  } as const;

  for (const mode of SPIDER_MODES) {
    const openings = Array.from({ length: 24 }, (_, index) => {
      const deal = generateVerifiedSpiderDeal(`${mode}-difficulty-${index}`, mode);
      const tops = deal.columns.map((column) => column.at(-1)!);
      const rankCounts = new Map<number, number>();
      tops.forEach((card) => rankCounts.set(card.rank, (rankCounts.get(card.rank) ?? 0) + 1));
      const movableSources = tops.filter((card, source) =>
        tops.some((destination, target) => source !== target && destination.rank === card.rank + 1),
      ).length;
      const helpfulSources = tops.filter((card, source) =>
        tops.some((destination, target) =>
          source !== target &&
          destination.rank === card.rank + 1 &&
          destination.suit === card.suit,
        ),
      ).length;
      const orderedPairs = deal.columns.reduce(
        (total, column) => total + column.slice(1).filter((card, index) => {
          const cardBelow = column[index]!;
          return cardBelow.rank === card.rank + 1 && cardBelow.suit === card.suit;
        }).length,
        0,
      );
      return {
        rankVariety: rankCounts.size,
        largestRankGroup: Math.max(...rankCounts.values()),
        movableSources,
        helpfulSources,
        orderedPairs,
        solutionLength: deal.solution.length,
        firstStockDraw: deal.solution.findIndex((move) => move.type === "draw"),
      };
    });
    const helpfulAverage = openings.reduce((total, opening) => total + opening.helpfulSources, 0) / openings.length;
    const rankVarietyAverage = openings.reduce((total, opening) => total + opening.rankVariety, 0) / openings.length;
    const largestRankGroupAverage = openings.reduce((total, opening) => total + opening.largestRankGroup, 0) / openings.length;
    const orderedPairAverage = openings.reduce((total, opening) => total + opening.orderedPairs, 0) / openings.length;
    const solutionAverage = openings.reduce((total, opening) => total + opening.solutionLength, 0) / openings.length;
    const firstStockDrawAverage = openings.reduce((total, opening) => total + opening.firstStockDraw, 0) / openings.length;
    assert.ok(openings.every((opening) => opening.movableSources >= 2 && opening.movableSources <= 4), `${mode} did not guarantee two to four starting moves`);
    assert.ok(rankVarietyAverage >= 6, `${mode} exposed only ${rankVarietyAverage} distinct ranks on average`);
    assert.ok(largestRankGroupAverage < 3.5, `${mode} repeated one rank ${largestRankGroupAverage} times on average`);
    assert.ok(helpfulAverage < expectedMaximums[mode], `${mode} exposed ${helpfulAverage} immediately helpful sources`);
    assert.ok(orderedPairAverage < expectedOrderedPairMaximums[mode], `${mode} preassembled ${orderedPairAverage} hidden pairs`);
    assert.ok(solutionAverage >= 67, `${mode} proof path averaged only ${solutionAverage} moves`);
    assert.ok(firstStockDrawAverage < 35, `${mode} did not require stock until move ${firstStockDrawAverage} on average`);
  }
});

test("all four suit modes use the requested number of suits", () => {
  for (const mode of SPIDER_MODES) {
    const state = spiderEngines[mode].generateInitialState("suit-count", ["p1", "p2"]);
    const suits = new Set([...state.initialColumns.flat(), ...state.initialStock.flat()].map((card) => card.suit));
    assert.equal(suits.size, Number(mode[0]), `${mode} should contain exactly ${mode[0]} suits`);
  }
});

test("deals use a full Spider deck with ten columns, hidden cards, and five stock sets", () => {
  const state = spiderEngines["4-suit"].generateInitialState("full-tableau", ["p1", "p2"]);
  const player = state.players.p1!;
  assert.equal(player.columns.length, 10);
  assert.deepEqual(
    player.columns.map((column) => column.length),
    [6, 6, 6, 6, 5, 5, 5, 5, 5, 5],
    "every game should open with the classic Spider column distribution",
  );
  assert.equal(player.columns.flat().length, 54);
  assert.equal(player.stock.length, 5);
  assert.ok(player.stock.every((batch) => batch.length === 10));
  assert.equal(player.stock.flat().length, 50);
  assert.equal(player.columns.flat().filter((card) => !card.faceUp).length, 44);
  assert.deepEqual(player.columns.map((column) => column.filter((card) => !card.faceUp).length), [5, 5, 5, 5, 4, 4, 4, 4, 4, 4]);
  assert.ok(player.columns.every((column) => column.at(-1)?.faceUp));
  assert.ok(player.stock.flat().every((card) => !card.faceUp));
});

test("every generated deal in every suit mode includes a legal solution", () => {
  for (const mode of SPIDER_MODES) {
    const engine = spiderEngines[mode];
    for (const seed of Array.from({ length: 40 }, (_, index) => `${mode}-solvable-${index}`)) {
      const deal = generateVerifiedSpiderDeal(seed, mode);
      let state = engine.generateInitialState(seed, ["p1", "p2"]);
      let stockDraws = 0;
      for (const move of deal.solution) {
        engine.validateMove(state, move, "p1");
        state = engine.applyMove(state, move, "p1").state;
        if (move.type === "draw") stockDraws += 1;
        if (state.players.p1!.completedRuns > 0) {
          assert.equal(
            state.players.p1!.stock.length,
            0,
            `${mode}/${seed} completed a run before using all five stock sets`,
          );
        }
      }

      assert.equal(stockDraws, 5, `expected ${mode}/${seed} to use all five stock sets`);
      assert.equal(state.players.p1!.completedRuns, 8, `expected ${mode}/${seed} to complete all runs`);
      assert.equal(state.players.p1!.stock.length, 0);
      assert.equal(state.players.p1!.columns.flat().length, 0);
      assert.equal(state.players.p1!.solved, true);
      assert.equal(engine.isTerminal(state), true);
      assert.equal(engine.getResult(state).winnerId, "p1");
    }
  }
});

test("rejects moving a broken stack or placing on the wrong rank", () => {
  const state = spiderOneSuitEngine.generateInitialState("invalid-move", ["p1", "p2"]);
  const player = state.players.p1!;
  const hiddenColumn = player.columns.findIndex((column) => column.some((card) => !card.faceUp));
  const hiddenIndex = player.columns[hiddenColumn]!.findIndex((card) => !card.faceUp);
  assert.throws(
    () => spiderOneSuitEngine.validateMove(state, { type: "move", fromColumn: hiddenColumn, cardIndex: hiddenIndex, toColumn: (hiddenColumn + 1) % 10 }, "p1"),
    GameRuleViolation,
  );

  const source = player.columns.findIndex((column) => column.length > 0);
  const cardIndex = player.columns[source]!.length - 1;
  const movingRank = player.columns[source]![cardIndex]!.rank;
  const invalidTarget = player.columns.findIndex(
    (column, index) => index !== source && column.length > 0 && column.at(-1)!.rank !== movingRank + 1,
  );
  assert.ok(invalidTarget >= 0);
  assert.throws(
    () => spiderOneSuitEngine.validateMove(state, { type: "move", fromColumn: source, cardIndex, toColumn: invalidTarget }, "p1"),
    GameRuleViolation,
  );
});

test("multi-card moves must stay within one suit", () => {
  const engine = spiderEngines["4-suit"];
  const state = engine.generateInitialState("mixed-stack", ["p1", "p2"]);
  const source = 0;
  const column = state.players.p1!.columns[source]!;
  const cardIndex = Math.max(0, column.length - 2);
  column.splice(
    cardIndex,
    column.length - cardIndex,
    { id: "mixed-five", rank: 5, suit: "spades", faceUp: true },
    { id: "mixed-four", rank: 4, suit: "hearts", faceUp: true },
  );
  const target = 1;
  state.players.p1!.columns[target] = [];
  assert.throws(
    () => engine.validateMove(state, { type: "move", fromColumn: source, cardIndex, toColumn: target }, "p1"),
    GameRuleViolation,
  );
});

test("reset restores the shared opening board without changing the opponent", () => {
  const seed = "reset-board";
  const deal = generateVerifiedSpiderDeal(seed);
  let state = spiderOneSuitEngine.generateInitialState(seed, ["p1", "p2"]);
  state = spiderOneSuitEngine.applyMove(state, deal.solution[0]!, "p1").state;
  assert.notDeepEqual(state.players.p1!.columns, state.initialColumns);

  state = spiderOneSuitEngine.applyMove(state, { type: "reset" }, "p1").state;
  assert.deepEqual(state.players.p1!.columns, state.initialColumns);
  assert.deepEqual(state.players.p1!.stock, state.initialStock);
  assert.deepEqual(state.players.p2!.columns, state.initialColumns);
  assert.equal(state.players.p1!.resetCount, 1);
});

test("drawing deals one face-up card to every column and take back restores the board", () => {
  let state = spiderOneSuitEngine.generateInitialState("draw-undo", ["p1", "p2"]);
  const before = state.players.p1!;
  const beforeLengths = before.columns.map((column) => column.length);

  state = spiderOneSuitEngine.applyMove(state, { type: "draw" }, "p1").state;
  const afterDraw = state.players.p1!;
  assert.deepEqual(afterDraw.columns.map((column) => column.length), beforeLengths.map((length) => length + 1));
  assert.ok(afterDraw.columns.every((column) => column.at(-1)?.faceUp));
  assert.equal(afterDraw.stock.length, 4);
  assert.equal(afterDraw.undoStack.length, 1);

  state = spiderOneSuitEngine.applyMove(state, { type: "undo" }, "p1").state;
  assert.deepEqual(state.players.p1!.columns, before.columns);
  assert.deepEqual(state.players.p1!.stock, before.stock);
  assert.equal(state.players.p1!.undoStack.length, 0);
});

test("drawing from stock is allowed while a tableau column is empty", () => {
  let state = spiderOneSuitEngine.generateInitialState("draw-with-empty-column", ["p1", "p2"]);
  state.players.p1!.columns[0] = [];

  assert.doesNotThrow(() => spiderOneSuitEngine.validateMove(state, { type: "draw" }, "p1"));
  state = spiderOneSuitEngine.applyMove(state, { type: "draw" }, "p1").state;

  assert.equal(state.players.p1!.columns[0]!.length, 1);
  assert.equal(state.players.p1!.columns[0]!.at(-1)?.faceUp, true);
  assert.equal(state.players.p1!.stock.length, 4);
});

test("take back reverses a move and restores the face-down card it exposed", () => {
  const seed = "move-undo";
  const firstMove = generateVerifiedSpiderDeal(seed).solution[0]!;
  let state = spiderOneSuitEngine.generateInitialState(seed, ["p1", "p2"]);
  const opening = state.players.p1!;

  state = spiderOneSuitEngine.applyMove(state, firstMove, "p1").state;
  assert.notDeepEqual(state.players.p1!.columns, opening.columns);
  state = spiderOneSuitEngine.applyMove(state, { type: "undo" }, "p1").state;
  assert.deepEqual(state.players.p1!.columns, opening.columns);
});

test("the player view exposes only opponent progress, not their board", () => {
  const state = spiderOneSuitEngine.generateInitialState("private-progress", ["p1", "p2"]);
  const view = spiderOneSuitEngine.serializeStateForPlayer(state, "p1") as SpiderStateView;
  assert.equal(view.self.columns.length, 10);
  assert.equal(view.self.stock.length, 5);
  assert.equal(view.self.canUndo, false);
  assert.equal(view.opponent.remainingCards, 104);
  assert.equal(view.opponent.remainingDeals, 5);
  assert.equal("undoStack" in view.self, false);
  assert.equal("columns" in view.opponent, false);
});
