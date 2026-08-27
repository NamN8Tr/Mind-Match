"use client";

import type { Room } from "@colyseus/sdk";
import type { MatchResult, PlayerId, WordleMove, WordleStateView } from "@smart-rot/shared-types";
import { useEffect, useState, type FormEvent } from "react";
import { clearActiveMatch } from "../lib/match-storage";
import { WordleBoard } from "./WordleBoard";

interface MatchResultMessage {
  result: MatchResult;
  ratings: Record<PlayerId, { before: number; after: number }> | null;
  /** False when the server could not save the result — the shown outcome is real, the rating change isn't. */
  persisted: boolean;
}

interface MatchProps {
  room: Room;
  currentUserId: string;
  onExit: () => void;
}

export function Match({ room, currentUserId, onExit }: MatchProps) {
  const [view, setView] = useState<WordleStateView | null>(null);
  const [phase, setPhase] = useState<"waiting" | "active">("waiting");
  const [outcome, setOutcome] = useState<MatchResultMessage | null>(null);
  const [moveError, setMoveError] = useState<string | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [connectionLost, setConnectionLost] = useState(false);

  useEffect(() => {
    const offPhase = room.onMessage("phase", (value: "waiting" | "active") => setPhase(value));
    const offState = room.onMessage("state", (payload: WordleStateView) => {
      setView(payload);
      setMoveError(null);
    });
    const offResult = room.onMessage("result", (payload: MatchResultMessage) => {
      setOutcome(payload);
      clearActiveMatch();
    });
    const offRejected = room.onMessage("moveRejected", (payload: { message: string }) => {
      setMoveError(payload.message);
    });
    const handleLeave = (code: number) => {
      // Codes below 4000 mean an abnormal drop rather than a deliberate close
      // (our own room.leave()/disconnect() calls use 1000/4000). The server's
      // reconnection grace period is already handling this on its side; the
      // JSX below only shows this banner while the match hasn't concluded.
      if (code < 4000) setConnectionLost(true);
    };
    const handleReconnect = () => {
      setConnectionLost(false);
      room.send("ready");
    };
    room.onLeave(handleLeave);
    room.onReconnect(handleReconnect);

    // Listeners are attached — now ask the server for the opening snapshot.
    // Doing this here rather than letting the server push on join is what
    // makes delivery guaranteed instead of a race (see the "ready" handler
    // in apps/server/src/rooms/create-game-room.ts).
    room.send("ready");

    return () => {
      offPhase();
      offState();
      offResult();
      offRejected();
      room.onLeave.remove(handleLeave);
      room.onReconnect.remove(handleReconnect);
    };
  }, [room]);

  function submitGuess(event: FormEvent) {
    event.preventDefault();
    if (!view || phase !== "active" || view.self.solved || view.revealedAnswer) return;
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

  const gameOver = outcome !== null;
  const { result, ratings } = outcome ?? { result: null, ratings: null };
  const persistFailed = outcome !== null && !outcome.persisted;
  const won = result?.status === "win" && result.winnerId === currentUserId;
  const lost = result?.status === "win" && result.winnerId !== currentUserId;
  const aborted = result?.status === "aborted";
  const myRatingChange = ratings?.[currentUserId];

  return (
    <div className="card">
      {connectionLost && !gameOver && (
        <p className="error-text" style={{ textAlign: "center", marginBottom: 12 }}>
          Connection lost — attempting to reconnect <span className="spinner-dot" />
        </p>
      )}

      {phase === "waiting" && !gameOver && (
        <p className="muted" style={{ textAlign: "center", marginBottom: 12 }}>
          Waiting for your opponent to join <span className="spinner-dot" />
        </p>
      )}

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
            disabled={phase !== "active" || view.self.solved || view.self.guessesRemaining === 0}
            placeholder={`${view.wordLength} letters`}
          />
          <button className="btn" type="submit" disabled={phase !== "active" || inputValue.length !== view.wordLength}>
            Guess
          </button>
        </form>
      )}

      {moveError && <p className="error-text" style={{ textAlign: "center", marginTop: 10 }}>{moveError}</p>}

      {gameOver && (
        <div className="match-result">
          <h2>{aborted ? "Match aborted" : won ? "You won!" : lost ? "You lost" : "Draw"}</h2>
          <p className="muted">
            {view.revealedAnswer && (
              <>
                The word was <strong>{view.revealedAnswer}</strong>
                {" — "}
              </>
            )}
            {result?.reason}
          </p>
          {myRatingChange && (
            <p className="muted">
              Rating: {Math.round(myRatingChange.before)} → {Math.round(myRatingChange.after)} (
              {myRatingChange.after - myRatingChange.before >= 0 ? "+" : ""}
              {Math.round(myRatingChange.after - myRatingChange.before)})
            </p>
          )}
          {persistFailed && (
            <p className="error-text">
              The server couldn&apos;t save this result — your rating and match history are unchanged.
            </p>
          )}
          <button className="btn-secondary" onClick={onExit} style={{ marginTop: 16 }}>
            Back to lobby
          </button>
        </div>
      )}
    </div>
  );
}
