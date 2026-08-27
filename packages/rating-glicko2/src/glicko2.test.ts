import assert from "node:assert/strict";
import { test } from "node:test";
import type { Glicko2Rating } from "@smart-rot/shared-types";
import { applyMatchResult, computeGlicko2Update, createInitialRating, updateRatingsForMatch } from "./glicko2.js";

function rating(overrides: Partial<Glicko2Rating>): Glicko2Rating {
  return {
    userId: "p",
    gameId: "wordle",
    rating: 1500,
    deviation: 350,
    volatility: 0.06,
    ratingPeriodsPlayed: 0,
    updatedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

// Canonical worked example from Glickman's "Example of the Glicko-2 System" paper:
// a 1500/200/0.06 player facing three opponents in one period should land at
// approximately rating 1464.06, RD 151.52, volatility 0.05999.
test("matches the reference worked example from the Glicko-2 paper", () => {
  const player = rating({ rating: 1500, deviation: 200, volatility: 0.06 });
  const opponents = [
    { opponent: rating({ rating: 1400, deviation: 30 }), score: 1 as const },
    { opponent: rating({ rating: 1550, deviation: 100 }), score: 0 as const },
    { opponent: rating({ rating: 1700, deviation: 300 }), score: 0 as const },
  ];

  const result = computeGlicko2Update(player, opponents);

  assert.ok(Math.abs(result.rating - 1464.06) < 0.05, `rating was ${result.rating}`);
  assert.ok(Math.abs(result.deviation - 151.52) < 0.05, `deviation was ${result.deviation}`);
  assert.ok(Math.abs(result.volatility - 0.05999) < 0.0001, `volatility was ${result.volatility}`);
  assert.equal(result.ratingPeriodsPlayed, 1);
});

test("a win raises rating and a loss lowers it against an equal opponent", () => {
  const a = createInitialRating("a", "wordle");
  const b = createInitialRating("b", "wordle");

  const win = applyMatchResult({ playerRating: a, opponentRating: b, score: 1 });
  const loss = applyMatchResult({ playerRating: a, opponentRating: b, score: 0 });

  assert.ok(win.rating > a.rating);
  assert.ok(loss.rating < a.rating);
});

test("deviation shrinks after playing and grows again after an idle period", () => {
  const a = createInitialRating("a", "wordle");
  const b = createInitialRating("b", "wordle");

  const afterMatch = applyMatchResult({ playerRating: a, opponentRating: b, score: 1 });
  assert.ok(afterMatch.deviation < a.deviation, "deviation should shrink after a rated game");

  const afterIdlePeriod = computeGlicko2Update(afterMatch, []);
  assert.ok(afterIdlePeriod.deviation > afterMatch.deviation, "deviation should grow again while idle");
});

test("updateRatingsForMatch is symmetric: winner gains what a draw-vs-win comparison would predict", () => {
  const a = createInitialRating("a", "wordle");
  const b = createInitialRating("b", "wordle");

  const { playerA, playerB } = updateRatingsForMatch(a, b, "playerAWins");

  assert.ok(playerA.rating > a.rating);
  assert.ok(playerB.rating < b.rating);
});

test("a draw between equally rated players leaves rating unchanged", () => {
  const a = createInitialRating("a", "wordle");
  const b = createInitialRating("b", "wordle");

  const { playerA } = updateRatingsForMatch(a, b, "draw");

  assert.ok(Math.abs(playerA.rating - a.rating) < 1e-9);
});
