import assert from "node:assert/strict";
import { test } from "node:test";
import { GameRuleViolation, type SpiderStateView } from "@smart-rot/shared-types";
import { generateSolvableSpiderDeal, spiderSpeedEngine } from "./engine.js";

test("Spider deals are deterministic, identical for both players, and independently cloned", () => {
  const first = spiderSpeedEngine.generateInitialState("shared-board", ["p1", "p2"]);
  const second = spiderSpeedEngine.generateInitialState("shared-board", ["p1", "p2"]);

  assert.deepEqual(first.players.p1!.columns, second.players.p1!.columns);
  assert.deepEqual(first.players.p1!.columns, first.players.p2!.columns);
  assert.notEqual(first.players.p1!.columns, first.players.p2!.columns);
});

test("different seeds create varied deals", () => {
  const deals = new Set(
    Array.from({ length: 12 }, (_, index) => JSON.stringify(generateSolvableSpiderDeal(`seed-${index}`).columns)),
  );
  assert.ok(deals.size > 1);
});

test("every generated deal includes a legal solution that completes all four runs", () => {
  for (const seed of Array.from({ length: 40 }, (_, index) => `solvable-${index}`)) {
    const deal = generateSolvableSpiderDeal(seed);
    let state = spiderSpeedEngine.generateInitialState(seed, ["p1", "p2"]);
    for (const move of deal.solution) {
      spiderSpeedEngine.validateMove(state, move, "p1");
      state = spiderSpeedEngine.applyMove(state, move, "p1").state;
    }

    assert.equal(state.players.p1!.completedRuns, 4, `expected ${seed} to complete all runs`);
    assert.equal(state.players.p1!.solved, true);
    assert.equal(spiderSpeedEngine.isTerminal(state), true);
    assert.equal(spiderSpeedEngine.getResult(state).winnerId, "p1");
  }
});

test("rejects moving a broken stack or placing on the wrong rank", () => {
  const state = spiderSpeedEngine.generateInitialState("invalid-move", ["p1", "p2"]);
  const player = state.players.p1!;
  const brokenColumn = player.columns.findIndex((column) =>
    column.some((card, index) => index > 0 && column[index - 1]!.rank !== card.rank + 1),
  );
  assert.ok(brokenColumn >= 0);
  const breakIndex = player.columns[brokenColumn]!.findIndex(
    (card, index) => index > 0 && player.columns[brokenColumn]![index - 1]!.rank !== card.rank + 1,
  );
  assert.throws(
    () => spiderSpeedEngine.validateMove(state, { type: "move", fromColumn: brokenColumn, cardIndex: breakIndex - 1, toColumn: (brokenColumn + 1) % 8 }, "p1"),
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
    () => spiderSpeedEngine.validateMove(state, { type: "move", fromColumn: source, cardIndex, toColumn: invalidTarget }, "p1"),
    GameRuleViolation,
  );
});

test("reset restores the shared opening board without changing the opponent", () => {
  const seed = "reset-board";
  const deal = generateSolvableSpiderDeal(seed);
  let state = spiderSpeedEngine.generateInitialState(seed, ["p1", "p2"]);
  state = spiderSpeedEngine.applyMove(state, deal.solution[0]!, "p1").state;
  assert.notDeepEqual(state.players.p1!.columns, state.initialColumns);

  state = spiderSpeedEngine.applyMove(state, { type: "reset" }, "p1").state;
  assert.deepEqual(state.players.p1!.columns, state.initialColumns);
  assert.deepEqual(state.players.p2!.columns, state.initialColumns);
  assert.equal(state.players.p1!.resetCount, 1);
});

test("the player view exposes only opponent progress, not their board", () => {
  const state = spiderSpeedEngine.generateInitialState("private-progress", ["p1", "p2"]);
  const view = spiderSpeedEngine.serializeStateForPlayer(state, "p1") as SpiderStateView;
  assert.equal(view.self.columns.length, 8);
  assert.equal(view.opponent.remainingCards, 52);
  assert.equal("columns" in view.opponent, false);
});
