/** Every ranked or timed mode listed under achievements, in display order. */
export const ACHIEVEMENT_MODES = [
  { gameId: "wordle", mode: "speed", gameLabel: "Wordle", modeLabel: "Speed", timed: true },
  { gameId: "wordle", mode: "fewest-guesses", gameLabel: "Wordle", modeLabel: "Fewest Guesses", timed: false },
  { gameId: "spider", mode: "1-suit", gameLabel: "Spider", modeLabel: "1 Suit", timed: true },
  { gameId: "spider", mode: "2-suit", gameLabel: "Spider", modeLabel: "2 Suits", timed: true },
  { gameId: "spider", mode: "3-suit", gameLabel: "Spider", modeLabel: "3 Suits", timed: true },
  { gameId: "spider", mode: "4-suit", gameLabel: "Spider", modeLabel: "4 Suits", timed: true },
] as const;

/**
 * Whether a stored rating/personal-best row belongs to `mode`. Spider shipped
 * with a single mode persisted as "speed"; those rows are the 1-suit pool.
 */
export function isSameMode(gameId: string, storedMode: string, mode: string): boolean {
  return storedMode === mode || (gameId === "spider" && mode === "1-suit" && storedMode === "speed");
}
