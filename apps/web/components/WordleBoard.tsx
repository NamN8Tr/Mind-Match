import type { WordleGuessFeedback } from "@smart-rot/shared-types";

interface WordleBoardProps {
  wordLength: number;
  maxGuesses: number;
  guesses: WordleGuessFeedback[];
  pendingInput?: string;
}

export function WordleBoard({ wordLength, maxGuesses, guesses, pendingInput }: WordleBoardProps) {
  const rows = Array.from({ length: maxGuesses }, (_, rowIndex) => {
    const submitted = guesses[rowIndex];
    if (submitted) {
      return submitted.letters.map((state, i) => ({ letter: submitted.guess[i] ?? "", state }));
    }
    if (rowIndex === guesses.length && pendingInput !== undefined) {
      return Array.from({ length: wordLength }, (_, i) => ({
        letter: pendingInput[i] ?? "",
        state: "pending" as const,
      }));
    }
    return Array.from({ length: wordLength }, () => ({ letter: "", state: "empty" as const }));
  });

  return (
    <div className="wordle-board">
      {rows.map((row, rowIndex) => (
        <div className="wordle-row" key={rowIndex}>
          {row.map((cell, cellIndex) => (
            <div className={`wordle-cell ${cell.state}`} key={cellIndex}>
              {cell.letter}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
