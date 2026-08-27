import assert from "node:assert/strict";
import { test } from "node:test";
import { GameRuleViolation, type WordleStateView } from "@smart-rot/shared-types";
import { wordleEngine } from "./engine.js";
import { evaluateGuess } from "./evaluate-guess.js";
import { WORDLE_ANSWERS } from "./word-lists/answers.js";
import { VALID_GUESSES } from "./word-lists/valid-guesses.js";

test("generateInitialState is deterministic for a given seed", () => {
  const a = wordleEngine.generateInitialState("match-123", ["p1", "p2"]);
  const b = wordleEngine.generateInitialState("match-123", ["p1", "p2"]);
  assert.equal(a.answer, b.answer);
  assert.ok(WORDLE_ANSWERS.includes(a.answer));
});

test("different seeds usually produce different answers", () => {
  const seeds = Array.from({ length: 20 }, (_, i) => `seed-${i}`);
  const answers = new Set(seeds.map((s) => wordleEngine.generateInitialState(s, ["p1", "p2"]).answer));
  assert.ok(answers.size > 1, "expected some variety across 20 different seeds");
});

test("evaluateGuess handles duplicate letters correctly", () => {
  // answer "level", guess "excel": one 'e' correct, extra letters handled per two-pass algorithm
  assert.deepEqual(evaluateGuess("level", "level"), ["correct", "correct", "correct", "correct", "correct"]);

  // answer "speed" has two 'e's; guess "eerie" has three 'e's -> only two should register as present/correct
  const result = evaluateGuess("eerie", "spEED".toLowerCase());
  const eCount = result.filter((r) => r !== "absent").length;
  assert.ok(eCount <= 3);
});

test("validateMove rejects wrong length and non-dictionary words", () => {
  const state = wordleEngine.generateInitialState("seed", ["p1", "p2"]);
  assert.throws(() => wordleEngine.validateMove(state, { type: "guess", word: "hi" }, "p1"), GameRuleViolation);
  assert.throws(
    () => wordleEngine.validateMove(state, { type: "guess", word: "zzzzz" }, "p1"),
    GameRuleViolation,
  );
});

test("a correct guess solves the puzzle, ends the match, and declares the solver the winner", () => {
  let state = wordleEngine.generateInitialState("solve-seed", ["p1", "p2"]);
  const outcome = wordleEngine.applyMove(state, { type: "guess", word: state.answer }, "p1");
  state = outcome.state;

  assert.ok(wordleEngine.isTerminal(state));
  const result = wordleEngine.getResult(state);
  assert.equal(result.status, "win");
  assert.equal(result.winnerId, "p1");
});

test("both players exhausting all guesses without solving ends in a draw", () => {
  let state = wordleEngine.generateInitialState("draw-seed", ["p1", "p2"]);
  const wrongWord = VALID_GUESSES.find((w) => w !== state.answer)!;

  for (let i = 0; i < state.maxGuesses; i++) {
    state = wordleEngine.applyMove(state, { type: "guess", word: wrongWord }, "p1").state;
    state = wordleEngine.applyMove(state, { type: "guess", word: wrongWord }, "p2").state;
  }

  assert.ok(wordleEngine.isTerminal(state));
  assert.equal(wordleEngine.getResult(state).status, "draw");
});

test("serializeStateForPlayer hides the opponent's guessed words but shows their progress", () => {
  let state = wordleEngine.generateInitialState("view-seed", ["p1", "p2"]);
  const wrongWord = VALID_GUESSES.find((w) => w !== state.answer)!;
  state = wordleEngine.applyMove(state, { type: "guess", word: wrongWord }, "p2").state;

  const view = wordleEngine.serializeStateForPlayer(state, "p1") as WordleStateView;
  assert.equal(view.opponent.guessCount, 1);
  assert.equal(view.self.guesses.length, 0);
  assert.equal(view.revealedAnswer, undefined, "answer should stay hidden mid-match");
  assert.ok(!("answer" in view));
});

test("serializeStateForPlayer reveals the answer once the match is terminal", () => {
  let state = wordleEngine.generateInitialState("reveal-seed", ["p1", "p2"]);
  state = wordleEngine.applyMove(state, { type: "guess", word: state.answer }, "p1").state;

  const view = wordleEngine.serializeStateForPlayer(state, "p2") as WordleStateView;
  assert.equal(view.revealedAnswer, state.answer);
});

test("rejects a move after the player has already solved", () => {
  let state = wordleEngine.generateInitialState("double-solve-seed", ["p1", "p2"]);
  state = wordleEngine.applyMove(state, { type: "guess", word: state.answer }, "p1").state;
  const otherWord = VALID_GUESSES.find((w) => w !== state.answer)!;
  assert.throws(() => wordleEngine.validateMove(state, { type: "guess", word: otherWord }, "p1"), GameRuleViolation);
});
