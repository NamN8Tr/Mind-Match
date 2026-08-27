import type { LetterState } from "@smart-rot/shared-types";

/**
 * Standard two-pass Wordle feedback algorithm that handles duplicate letters
 * correctly: greens are claimed first, then yellows are assigned only for
 * letters still "available" in the answer after greens are removed.
 */
export function evaluateGuess(guess: string, answer: string): LetterState[] {
  const length = answer.length;
  const result: LetterState[] = new Array(length).fill("absent");
  const remaining = new Map<string, number>();

  for (let i = 0; i < length; i++) {
    const answerLetter = answer[i]!;
    if (guess[i] === answerLetter) {
      result[i] = "correct";
    } else {
      remaining.set(answerLetter, (remaining.get(answerLetter) ?? 0) + 1);
    }
  }

  for (let i = 0; i < length; i++) {
    if (result[i] === "correct") continue;
    const guessLetter = guess[i]!;
    const count = remaining.get(guessLetter) ?? 0;
    if (count > 0) {
      result[i] = "present";
      remaining.set(guessLetter, count - 1);
    }
  }

  return result;
}
