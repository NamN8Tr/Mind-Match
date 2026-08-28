"use client";

import type { SpiderCard, SpiderMove, SpiderPlayerState } from "@smart-rot/shared-types";
import { useState } from "react";

interface Selection {
  column: number;
  cardIndex: number;
  moveCount: number;
}

function rankLabel(rank: number): string {
  if (rank === 1) return "A";
  if (rank === 11) return "J";
  if (rank === 12) return "Q";
  if (rank === 13) return "K";
  return String(rank);
}

function isMovable(column: SpiderCard[], cardIndex: number): boolean {
  return column.slice(cardIndex).every((card, index, cards) => index === 0 || cards[index - 1]!.rank === card.rank + 1);
}

export function SpiderBoard({
  player,
  disabled,
  pending,
  onMove,
  onLocalError,
}: {
  player: SpiderPlayerState;
  disabled: boolean;
  pending: boolean;
  onMove: (move: SpiderMove) => void;
  onLocalError: (message: string) => void;
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const currentSelection = selection?.moveCount === player.moveCount ? selection : null;

  function chooseCard(columnIndex: number, cardIndex: number): void {
    if (disabled || pending) return;
    if (currentSelection && currentSelection.column !== columnIndex) {
      onMove({ type: "move", fromColumn: currentSelection.column, cardIndex: currentSelection.cardIndex, toColumn: columnIndex });
      return;
    }

    const column = player.columns[columnIndex]!;
    if (!isMovable(column, cardIndex)) {
      setSelection(null);
      onLocalError("Select a descending stack");
      return;
    }
    if (currentSelection?.column === columnIndex && currentSelection.cardIndex === cardIndex) {
      setSelection(null);
    } else {
      setSelection({ column: columnIndex, cardIndex, moveCount: player.moveCount });
    }
  }

  function chooseEmptyColumn(columnIndex: number): void {
    if (!currentSelection || disabled || pending) return;
    onMove({ type: "move", fromColumn: currentSelection.column, cardIndex: currentSelection.cardIndex, toColumn: columnIndex });
  }

  return (
    <div className="spider-board-wrap">
      <div className="spider-board" aria-label="Spider tableau">
        {player.columns.map((column, columnIndex) => (
          <div className={`spider-column${currentSelection?.column === columnIndex ? " has-selection" : ""}`} key={columnIndex}>
            {column.length === 0 ? (
              <button
                type="button"
                className={`spider-empty-column${currentSelection ? " can-receive" : ""}`}
                aria-label={`Move selected stack to empty column ${columnIndex + 1}`}
                disabled={!currentSelection || disabled || pending}
                onClick={() => chooseEmptyColumn(columnIndex)}
              >
                <span>♠</span>
              </button>
            ) : (
              column.map((card, cardIndex) => {
                const selected = currentSelection?.column === columnIndex && cardIndex >= currentSelection.cardIndex;
                return (
                  <button
                    type="button"
                    className={`spider-card${selected ? " selected" : ""}`}
                    aria-label={`${rankLabel(card.rank)} of spades, column ${columnIndex + 1}${selected ? ", selected" : ""}`}
                    key={card.id}
                    onClick={() => chooseCard(columnIndex, cardIndex)}
                    disabled={disabled || pending}
                  >
                    <span className="spider-card-rank">{rankLabel(card.rank)}</span>
                    <span className="spider-card-suit" aria-hidden="true">♠</span>
                  </button>
                );
              })
            )}
          </div>
        ))}
      </div>
      <p className="spider-board-help">
        {currentSelection ? "Now choose a destination column." : "Select a descending stack, then choose where to place it."}
      </p>
    </div>
  );
}
