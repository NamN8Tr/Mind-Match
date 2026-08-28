import type { LetterState, WordleGuessFeedback } from "@smart-rot/shared-types";

const KEY_ROWS = [
  ["Q", "W", "E", "R", "T", "Y", "U", "I", "O", "P"],
  ["A", "S", "D", "F", "G", "H", "J", "K", "L"],
  ["ENTER", "Z", "X", "C", "V", "B", "N", "M", "BACKSPACE"],
] as const;

const STATE_PRIORITY: Record<LetterState, number> = {
  absent: 1,
  present: 2,
  correct: 3,
};

interface WordleKeyboardProps {
  guesses: WordleGuessFeedback[];
  disabled: boolean;
  onKey: (key: string) => void;
}

function getLetterStates(guesses: WordleGuessFeedback[]): Partial<Record<string, LetterState>> {
  const states: Partial<Record<string, LetterState>> = {};

  for (const guess of guesses) {
    guess.letters.forEach((state, index) => {
      const letter = guess.guess[index]?.toUpperCase();
      if (!letter) return;
      const previous = states[letter];
      if (!previous || STATE_PRIORITY[state] > STATE_PRIORITY[previous]) states[letter] = state;
    });
  }

  return states;
}

export function WordleKeyboard({ guesses, disabled, onKey }: WordleKeyboardProps) {
  const letterStates = getLetterStates(guesses);

  return (
    <div aria-label="Wordle keyboard" className="wordle-keyboard" role="group">
      {KEY_ROWS.map((row, rowIndex) => (
        <div className="keyboard-row" key={rowIndex}>
          {row.map((key) => {
            const isAction = key === "ENTER" || key === "BACKSPACE";
            const state = isAction ? undefined : letterStates[key];
            const label = key === "BACKSPACE" ? "Backspace" : key === "ENTER" ? "Enter" : key;

            return (
              <button
                aria-label={label}
                className={`keyboard-key${isAction ? " wide" : ""}${state ? ` ${state}` : ""}`}
                disabled={disabled}
                key={key}
                onClick={() => onKey(key)}
                type="button"
              >
                {key === "BACKSPACE" ? <span aria-hidden="true">⌫</span> : key}
              </button>
            );
          })}
        </div>
      ))}
    </div>
  );
}
