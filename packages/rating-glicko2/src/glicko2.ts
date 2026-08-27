import {
  DEFAULT_GLICKO2_DEVIATION,
  DEFAULT_GLICKO2_RATING,
  DEFAULT_GLICKO2_VOLATILITY,
  type GameId,
  type Glicko2Rating,
  type MatchOutcomeForRating,
  type PlayerId,
  type RatingUpdateInput,
} from "@smart-rot/shared-types";

/**
 * Faithful implementation of Mark Glickman's Glicko-2 algorithm, following the
 * step numbering in "Example of the Glicko-2 system"
 * (http://www.glicko.net/glicko/glicko2.pdf).
 *
 * We treat every completed match as its own one-game rating period rather than
 * batching games (the paper's more common usage) — appropriate for a live,
 * continuously-played ladder rather than a periodic tournament.
 */

const SCALE = 173.7178;
/** System constant restraining volatility change over time. 0.3-1.2 is the paper's suggested range; smaller = more conservative. */
const TAU = 0.5;
const CONVERGENCE_EPSILON = 0.000001;

interface Glicko2Scale {
  mu: number;
  phi: number;
  sigma: number;
}

interface OpponentResult {
  opponent: Glicko2Rating;
  score: MatchOutcomeForRating;
}

function toGlicko2Scale(rating: Glicko2Rating): Glicko2Scale {
  return {
    mu: (rating.rating - DEFAULT_GLICKO2_RATING) / SCALE,
    phi: rating.deviation / SCALE,
    sigma: rating.volatility,
  };
}

/** Step 3 helper: reduces the impact of high-deviation opponents. */
function g(phi: number): number {
  return 1 / Math.sqrt(1 + (3 * phi * phi) / (Math.PI * Math.PI));
}

/** Step 3 helper: expected score against an opponent. */
function expectedScore(mu: number, muOpponent: number, phiOpponent: number): number {
  return 1 / (1 + Math.exp(-g(phiOpponent) * (mu - muOpponent)));
}

/** Step 3: estimated variance of the player's rating based on this period's game(s). */
function computeVariance(mu: number, opponents: Glicko2Scale[]): number {
  let sum = 0;
  for (const opp of opponents) {
    const gPhi = g(opp.phi);
    const e = expectedScore(mu, opp.mu, opp.phi);
    sum += gPhi * gPhi * e * (1 - e);
  }
  return 1 / sum;
}

/** Step 4: estimated improvement in rating from this period's game(s). */
function computeDelta(mu: number, v: number, opponents: { scale: Glicko2Scale; score: number }[]): number {
  let sum = 0;
  for (const { scale, score } of opponents) {
    sum += g(scale.phi) * (score - expectedScore(mu, scale.mu, scale.phi));
  }
  return v * sum;
}

/** Step 5: Illinois algorithm (regula falsi) root-find for the new volatility. */
function computeNewVolatility(phi: number, sigma: number, delta: number, v: number): number {
  const a = Math.log(sigma * sigma);
  const f = (x: number): number => {
    const ex = Math.exp(x);
    const num = ex * (delta * delta - phi * phi - v - ex);
    const den = 2 * Math.pow(phi * phi + v + ex, 2);
    return num / den - (x - a) / (TAU * TAU);
  };

  let A = a;
  let B: number;
  if (delta * delta > phi * phi + v) {
    B = Math.log(delta * delta - phi * phi - v);
  } else {
    let k = 1;
    while (f(a - k * TAU) < 0) {
      k += 1;
    }
    B = a - k * TAU;
  }

  let fA = f(A);
  let fB = f(B);

  while (Math.abs(B - A) > CONVERGENCE_EPSILON) {
    const C = A + ((A - B) * fA) / (fB - fA);
    const fC = f(C);
    if (fC * fB < 0) {
      A = B;
      fA = fB;
    } else {
      fA = fA / 2;
    }
    B = C;
    fB = fC;
  }

  return Math.exp(A / 2);
}

/**
 * Runs a full Glicko-2 update for one player against one or more opponents played
 * within a single rating period. Pass an empty `results` array to represent a
 * period in which the player didn't play (deviation still grows toward uncertainty).
 */
export function computeGlicko2Update(player: Glicko2Rating, results: OpponentResult[]): Glicko2Rating {
  const { mu, phi, sigma } = toGlicko2Scale(player);

  if (results.length === 0) {
    const phiStar = Math.sqrt(phi * phi + sigma * sigma);
    return {
      ...player,
      deviation: phiStar * SCALE,
      updatedAt: new Date().toISOString(),
    };
  }

  const opponentScales = results.map((r) => ({
    scale: toGlicko2Scale(r.opponent),
    score: r.score,
  }));

  const v = computeVariance(
    mu,
    opponentScales.map((o) => o.scale),
  );
  const delta = computeDelta(mu, v, opponentScales);
  const newSigma = computeNewVolatility(phi, sigma, delta, v);

  const phiStar = Math.sqrt(phi * phi + newSigma * newSigma);
  const newPhi = 1 / Math.sqrt(1 / (phiStar * phiStar) + 1 / v);

  let sum = 0;
  for (const { scale, score } of opponentScales) {
    sum += g(scale.phi) * (score - expectedScore(mu, scale.mu, scale.phi));
  }
  const newMu = mu + newPhi * newPhi * sum;

  return {
    userId: player.userId,
    gameId: player.gameId,
    rating: newMu * SCALE + DEFAULT_GLICKO2_RATING,
    deviation: newPhi * SCALE,
    volatility: newSigma,
    ratingPeriodsPlayed: player.ratingPeriodsPlayed + 1,
    updatedAt: new Date().toISOString(),
  };
}

/** Convenience wrapper for the common case: one match against one opponent. */
export function applyMatchResult(input: RatingUpdateInput): Glicko2Rating {
  return computeGlicko2Update(input.playerRating, [{ opponent: input.opponentRating, score: input.score }]);
}

/**
 * Updates both players' ratings for a single completed match. Both updates are
 * computed from each player's pre-match rating, matching how Glicko-2 handles
 * simultaneous opponents within one rating period.
 */
export function updateRatingsForMatch(
  playerA: Glicko2Rating,
  playerB: Glicko2Rating,
  outcome: "playerAWins" | "playerBWins" | "draw",
): { playerA: Glicko2Rating; playerB: Glicko2Rating } {
  const scoreA: MatchOutcomeForRating = outcome === "playerAWins" ? 1 : outcome === "playerBWins" ? 0 : 0.5;
  const scoreB: MatchOutcomeForRating = outcome === "playerBWins" ? 1 : outcome === "playerAWins" ? 0 : 0.5;

  return {
    playerA: applyMatchResult({ playerRating: playerA, opponentRating: playerB, score: scoreA }),
    playerB: applyMatchResult({ playerRating: playerB, opponentRating: playerA, score: scoreB }),
  };
}

export function createInitialRating(userId: PlayerId, gameId: GameId): Glicko2Rating {
  return {
    userId,
    gameId,
    rating: DEFAULT_GLICKO2_RATING,
    deviation: DEFAULT_GLICKO2_DEVIATION,
    volatility: DEFAULT_GLICKO2_VOLATILITY,
    ratingPeriodsPlayed: 0,
    updatedAt: new Date().toISOString(),
  };
}
