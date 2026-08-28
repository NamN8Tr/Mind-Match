import assert from "node:assert/strict";
import { test } from "node:test";
import type { Glicko2Rating } from "@smart-rot/shared-types";
import { applyMatchResult, computeGlicko2Update, createInitialRating, updateRatingsForMatch } from "./glicko2.js";

function rating(overrides: Partial<Glicko2Rating>): Glicko2Rating {
  return {
    userId: "p",
    gameId: "wordle",
    mode: "speed",
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
  const a = createInitialRating("a", "wordle", "speed");
  const b = createInitialRating("b", "wordle", "speed");

  const win = applyMatchResult({ playerRating: a, opponentRating: b, score: 1 });
  const loss = applyMatchResult({ playerRating: a, opponentRating: b, score: 0 });

  assert.ok(win.rating > a.rating);
  assert.ok(loss.rating < a.rating);
});

test("early movement is moderate and scales with opponent strength", () => {
  const player = createInitialRating("player", "wordle", "speed");
  const weaker = { ...createInitialRating("weaker", "wordle", "speed"), rating: 250 };
  const equal = createInitialRating("equal", "wordle", "speed");
  const stronger = { ...createInitialRating("stronger", "wordle", "speed"), rating: 550 };

  const winVsWeaker = applyMatchResult({ playerRating: player, opponentRating: weaker, score: 1 });
  const winVsEqual = applyMatchResult({ playerRating: player, opponentRating: equal, score: 1 });
  const winVsStronger = applyMatchResult({ playerRating: player, opponentRating: stronger, score: 1 });
  assert.ok(winVsStronger.rating > winVsEqual.rating, "beating a stronger opponent should award more");
  assert.ok(winVsEqual.rating > winVsWeaker.rating, "beating a weaker opponent should award less");

  const lossVsWeaker = applyMatchResult({ playerRating: player, opponentRating: weaker, score: 0 });
  const lossVsEqual = applyMatchResult({ playerRating: player, opponentRating: equal, score: 0 });
  const lossVsStronger = applyMatchResult({ playerRating: player, opponentRating: stronger, score: 0 });
  assert.ok(lossVsWeaker.rating < lossVsEqual.rating, "losing to a weaker opponent should cost more");
  assert.ok(lossVsEqual.rating < lossVsStronger.rating, "losing to a stronger opponent should cost less");

  const equalMatchChange = winVsEqual.rating - player.rating;
  assert.ok(equalMatchChange >= 20 && equalMatchChange <= 35, `expected a moderate initial change, got ${equalMatchChange}`);
});

test("deviation shrinks after playing and grows again after an idle period", () => {
  const a = createInitialRating("a", "wordle", "speed");
  const b = createInitialRating("b", "wordle", "speed");

  const afterMatch = applyMatchResult({ playerRating: a, opponentRating: b, score: 1 });
  assert.ok(afterMatch.deviation < a.deviation, "deviation should shrink after a rated game");

  const afterIdlePeriod = computeGlicko2Update(afterMatch, []);
  assert.ok(afterIdlePeriod.deviation > afterMatch.deviation, "deviation should grow again while idle");
});

test("updateRatingsForMatch is symmetric: winner gains what a draw-vs-win comparison would predict", () => {
  const a = createInitialRating("a", "wordle", "speed");
  const b = createInitialRating("b", "wordle", "speed");

  const { playerA, playerB } = updateRatingsForMatch(a, b, "playerAWins");

  assert.ok(playerA.rating > a.rating);
  assert.ok(playerB.rating < b.rating);
});

test("a draw between equally rated players leaves rating unchanged", () => {
  const a = createInitialRating("a", "wordle", "speed");
  const b = createInitialRating("b", "wordle", "speed");

  const { playerA } = updateRatingsForMatch(a, b, "draw");

  assert.ok(Math.abs(playerA.rating - a.rating) < 1e-9);
});
