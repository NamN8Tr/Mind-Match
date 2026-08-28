import type { LetterState } from "@smart-rot/shared-types";

interface OpponentWordleBoardProps {
  displayName?: string;
  wordLength: number;
  maxGuesses: number;
  feedback: LetterState[][];
  solved: boolean;
}

export function OpponentWordleBoard({ displayName, wordLength, maxGuesses, feedback, solved }: OpponentWordleBoardProps) {
  return (
    <aside className="opponent-board-panel" aria-label="Opponent's Wordle progress">
      <div className="opponent-board-heading">
        <span>{displayName ?? "Opponent"}</span>
        {solved && <span className="opponent-solved">Solved</span>}
      </div>
      <div className="opponent-mini-board" aria-label={`${feedback.length} of ${maxGuesses} guesses used`}>
        {Array.from({ length: maxGuesses }, (_, rowIndex) => (
          <div
            className="opponent-mini-row"
            key={rowIndex}
            style={{ gridTemplateColumns: `repeat(${wordLength}, 1fr)` }}
          >
            {Array.from({ length: wordLength }, (_, cellIndex) => {
              const state = feedback[rowIndex]?.[cellIndex];
              return <span className={`opponent-mini-cell${state ? ` ${state}` : ""}`} key={cellIndex} />;
            })}
          </div>
        ))}
      </div>
    </aside>
  );
}
