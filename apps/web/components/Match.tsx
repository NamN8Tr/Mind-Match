"use client";

import type { Room } from "@colyseus/sdk";
import type { MatchResult, WordleMove, WordleStateView } from "@smart-rot/shared-types";
import { useEffect, useState, type FormEvent } from "react";
import { WordleBoard } from "./WordleBoard";

interface MatchProps {
  room: Room;
  currentUserId: string;
  onExit: () => void;
}

export function Match({ room, currentUserId, onExit }: MatchProps) {
  const [view, setView] = useState<WordleStateView | null>(null);
  const [result, setResult] = useState<MatchResult | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");

  useEffect(() => {
    const offState = room.onMessage("state", (payload: WordleStateView) => {
      setView(payload);
      setMoveError(null);
    });
    const offResult = room.onMessage("result", (payload: MatchResult) => {
      setResult(payload);
    });
    const offRejected = room.onMessage("moveRejected", (payload: { message: string }) => {
      setMoveError(payload.message);
    });
    return () => {
      offState();
      offResult();
      offRejected();
    };
  }, [room]);

  function submitGuess(event: FormEvent) {
    event.preventDefault();
    if (!view || view.self.solved || view.revealedAnswer) return;
    const word = inputValue.trim().toLowerCase();
    if (word.length !== view.wordLength) {
      setMoveError(`Guess must be ${view.wordLength} letters`);
      return;
    }
    const move: WordleMove = { type: "guess", word };
    room.send("move", move);
    setInputValue("");
  }

  if (!view) {
    return (
      <div className="card">
        <p className="muted">
          Connecting to match <span className="spinner-dot" />
        </p>
      </div>
    );
  }

  const gameOver = Boolean(view.revealedAnswer);
  const won = result?.status === "win" && result.winnerId === currentUserId;
  const lost = result?.status === "win" && result.winnerId !== currentUserId;

  return (
    <div className="card">
      <WordleBoard wordLength={view.wordLength} maxGuesses={view.maxGuesses} guesses={view.self.guesses} pendingInput={gameOver ? undefined : inputValue} />

      <div className="opponent-track">
        <span>Opponent:</span>
        <div className="opponent-dots">
          {Array.from({ length: view.maxGuesses }, (_, i) => (
            <span key={i} className={`opponent-dot ${i < view.opponent.guessCount ? "filled" : ""}`} />
          ))}
        </div>
        {view.opponent.solved && <span>solved it!</span>}
      </div>

      {!gameOver && (
        <form className="guess-form" onSubmit={submitGuess}>
          <input
            className="guess-input"
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value.replace(/[^a-zA-Z]/g, "").slice(0, view.wordLength))}
            maxLength={view.wordLength}
            autoFocus
            disabled={view.self.solved || view.self.guessesRemaining === 0}
            placeholder={`${view.wordLength} letters`}
          />
          <button className="btn" type="submit" disabled={inputValue.length !== view.wordLength}>
            Guess
          </button>
        </form>
      )}

      {moveError && <p className="error-text" style={{ textAlign: "center", marginTop: 10 }}>{moveError}</p>}

      {gameOver && (
        <div className="match-result">
          <h2>{won ? "You won!" : lost ? "You lost" : "Draw"}</h2>
          <p className="muted">
            The word was <strong>{view.revealedAnswer}</strong>
            {result?.reason ? ` — ${result.reason}` : ""}
          </p>
          <button className="btn-secondary" onClick={onExit} style={{ marginTop: 16 }}>
            Back to lobby
          </button>
        </div>
      )}
    </div>
  );
}
