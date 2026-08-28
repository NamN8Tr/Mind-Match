"use client";

import type { Room } from "@colyseus/sdk";
import type { MatchOpponentInfo, MatchResult, PlayerId, WordleMove, WordleStateView } from "@smart-rot/shared-types";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearActiveMatch } from "../lib/match-storage";
import { OpponentWordleBoard } from "./OpponentWordleBoard";
import { WordleBoard } from "./WordleBoard";
import { WordleKeyboard } from "./WordleKeyboard";
import { WordleNotice, type WordleNoticeMessage } from "./WordleNotice";

interface MatchResultMessage {
  result: MatchResult;
  ratings: Record<PlayerId, { before: number; after: number }> | null;
  /** False when the server could not save the result — the shown outcome is real, the rating change isn't. */
  persisted: boolean;
}

interface ClockMessage {
  startedAt: number;
  deadlineAt: number;
  serverNow: number;
}

interface SynchronizedClock extends ClockMessage {
  offsetMs: number;
}

interface CountdownMessage {
  endsAt: number;
  serverNow: number;
}

interface SynchronizedCountdown extends CountdownMessage {
  offsetMs: number;
}

interface MatchProps {
  room: Room;
  currentUserId: string;
  onExit: () => void;
}

export function Match({ room, currentUserId, onExit }: MatchProps) {
  const [view, setView] = useState<WordleStateView | null>(null);
  const [opponent, setOpponent] = useState<MatchOpponentInfo | null>(null);
  const [phase, setPhase] = useState<"waiting" | "countdown" | "active">("waiting");
  const [outcome, setOutcome] = useState<MatchResultMessage | null>(null);
  const [moveNotice, setMoveNotice] = useState<WordleNoticeMessage | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [submittingGuess, setSubmittingGuess] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [countdownClock, setCountdownClock] = useState<SynchronizedCountdown | null>(null);
  const [matchClock, setMatchClock] = useState<SynchronizedClock | null>(null);
  const [clockNow, setClockNow] = useState(() => Date.now());
  const [confirmingExit, setConfirmingExit] = useState(false);
  const selfGuessCountRef = useRef<number | null>(null);
  const keepPlayingButtonRef = useRef<HTMLButtonElement | null>(null);
  const moveNoticeIdRef = useRef(0);

  useEffect(() => {
    selfGuessCountRef.current = null;
    const offPhase = room.onMessage("phase", (value: "waiting" | "countdown" | "active") => {
      setPhase(value);
      if (value === "active") setCountdownClock(null);
    });
    const offCountdown = room.onMessage("countdown", (payload: CountdownMessage) => {
      const receivedAt = Date.now();
      setCountdownClock({ ...payload, offsetMs: payload.serverNow - receivedAt });
      setClockNow(receivedAt);
    });
    const offClock = room.onMessage("clock", (payload: ClockMessage) => {
      const receivedAt = Date.now();
      setMatchClock({ ...payload, offsetMs: payload.serverNow - receivedAt });
      setClockNow(receivedAt);
    });
    const offOpponent = room.onMessage("opponent", (payload: MatchOpponentInfo) => setOpponent(payload));
    const offState = room.onMessage("state", (payload: WordleStateView) => {
      const previousGuessCount = selfGuessCountRef.current;
      const nextGuessCount = payload.self.guesses.length;
      selfGuessCountRef.current = nextGuessCount;
      setView(payload);
      if (previousGuessCount === null || nextGuessCount > previousGuessCount) {
        setMoveNotice(null);
        setInputValue("");
        setSubmittingGuess(false);
      }
    });
    const offResult = room.onMessage("result", (payload: MatchResultMessage) => {
      setConnectionLost(false);
      setMoveNotice(null);
      setInputValue("");
      setSubmittingGuess(false);
      setOutcome(payload);
      clearActiveMatch();
    });
    const offRejected = room.onMessage("moveRejected", (payload: { message: string }) => {
      setSubmittingGuess(false);
      setMoveNotice({ id: ++moveNoticeIdRef.current, message: payload.message });
    });
    const handleLeave = (code: number) => {
      // Codes below 4000 mean an abnormal drop rather than a deliberate close
      // (our own room.leave()/disconnect() calls use 1000/4000). The server's
      // reconnection grace period is already handling this on its side; the
      // JSX below only shows this banner while the match hasn't concluded.
      if (code < 4000) setConnectionLost(true);
    };
    const handleDrop = () => {
      setConnectionLost(true);
      setSubmittingGuess(false);
    };
    const handleReconnect = () => {
      setConnectionLost(false);
      room.send("ready");
    };
    room.onLeave(handleLeave);
    room.onDrop(handleDrop);
    room.onReconnect(handleReconnect);

    // Listeners are attached — now ask the server for the opening snapshot.
    // Doing this here rather than letting the server push on join is what
    // makes delivery guaranteed instead of a race (see the "ready" handler
    // in apps/server/src/rooms/create-game-room.ts).
    room.send("ready");

    return () => {
      offPhase();
      offCountdown();
      offClock();
      offOpponent();
      offState();
      offResult();
      offRejected();
      room.onLeave.remove(handleLeave);
      room.onDrop.remove(handleDrop);
      room.onReconnect.remove(handleReconnect);
    };
  }, [room]);

  useEffect(() => {
    if (!moveNotice) return;
    const noticeId = moveNotice.id;
    const timeout = window.setTimeout(() => {
      setMoveNotice((current) => (current?.id === noticeId ? null : current));
    }, 2_200);
    return () => window.clearTimeout(timeout);
  }, [moveNotice]);

  useEffect(() => {
    const shouldTick = (phase === "countdown" && countdownClock !== null) || (phase === "active" && matchClock !== null);
    if (!shouldTick || outcome !== null) return;
    const updateClock = () => setClockNow(Date.now());
    updateClock();
    const interval = window.setInterval(updateClock, 250);
    return () => window.clearInterval(interval);
  }, [countdownClock, matchClock, outcome, phase]);

  const canPlay =
    view !== null &&
    phase === "active" &&
    outcome === null &&
    !confirmingExit &&
    !connectionLost &&
    !view.self.solved &&
    view.self.guessesRemaining > 0 &&
    !view.revealedAnswer;

  const handleKey = useCallback(
    (rawKey: string) => {
      if (!canPlay || !view || submittingGuess) return;

      const key = rawKey.toUpperCase();
      if (key === "ENTER") {
        if (inputValue.length !== view.wordLength) {
          setMoveNotice({
            id: ++moveNoticeIdRef.current,
            message: `Guess must be ${view.wordLength} letters`,
          });
          return;
        }
        const move: WordleMove = { type: "guess", word: inputValue.toLowerCase() };
        setMoveNotice(null);
        setSubmittingGuess(true);
        room.send("move", move);
        return;
      }

      if (key === "BACKSPACE" || key === "DELETE") {
        setInputValue((current) => current.slice(0, -1));
        return;
      }

      if (/^[A-Z]$/.test(key)) {
        setInputValue((current) => (current.length < view.wordLength ? `${current}${key.toLowerCase()}` : current));
      }
    },
    [canPlay, inputValue, room, submittingGuess, view],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      const supported = event.key === "Enter" || event.key === "Backspace" || event.key === "Delete" || /^[a-zA-Z]$/.test(event.key);
      if (!supported || !canPlay || submittingGuess) return;
      event.preventDefault();
      handleKey(event.key);
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [canPlay, handleKey, submittingGuess]);

  useEffect(() => {
    if (!confirmingExit) return;
    keepPlayingButtonRef.current?.focus();
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setConfirmingExit(false);
    }
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [confirmingExit]);

  // A concluded match has nothing left to forfeit, so the back button leaves
  // straight away rather than warning about a match that is already over.
  function requestExit(): void {
    if (outcome) {
      onExit();
      return;
    }
    setConfirmingExit(true);
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
  const countdownRemainingMs = countdownClock
    ? Math.max(0, countdownClock.endsAt - (clockNow + countdownClock.offsetMs))
    : null;
  const countdownNumber = countdownRemainingMs === null ? 3 : Math.max(1, Math.ceil(countdownRemainingMs / 1000));
  const remainingMs = matchClock ? Math.max(0, matchClock.deadlineAt - (clockNow + matchClock.offsetMs)) : null;
  const remainingSeconds = remainingMs === null ? null : Math.ceil(remainingMs / 1000);
  const formattedTime =
    remainingSeconds === null
      ? "--:--"
      : `${Math.floor(remainingSeconds / 60)}:${String(remainingSeconds % 60).padStart(2, "0")}`;
  const resultReason =
    result?.reason === "fewest-guesses"
      ? "Fewest guesses"
      : result?.reason === "fewest-guesses-timeout"
        ? "Solved before the deadline"
        : result?.reason === "same-guesses"
          ? "Same number of guesses"
          : result?.reason === "solved"
            ? "Fastest solve"
            : result?.reason;

  return (
    <div className="card match-card">
      {phase === "countdown" && !gameOver && (
        <div className="round-countdown" role="status" aria-live="assertive">
          <span>Get ready</span>
          <strong key={countdownNumber}>{countdownNumber}</strong>
        </div>
      )}

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

      <div className="match-toolbar">
        <button className="match-back-button" onClick={requestExit}>
          <span aria-hidden="true">←</span> Back
        </button>
        <span className={`match-mode-badge match-mode-${view.mode}`}>
          {view.mode === "speed" ? "Speed" : "Fewest guesses"}
        </span>
        {view.mode === "speed" && !gameOver && (
          <span className={`match-timer${remainingMs !== null && remainingMs <= 30_000 ? " urgent" : ""}`}>
            <span aria-hidden="true">◷</span> {formattedTime}
          </span>
        )}
      </div>

      {opponent && (
        <div className="opponent-identity" aria-label={`Playing against ${opponent.displayName}, rating ${Math.round(opponent.rating)}`}>
          <span>vs</span>
          <Link
            className="player-profile-link"
            href={`/players/${encodeURIComponent(opponent.userId)}`}
            target="_blank"
            rel="noreferrer"
            title={`Open ${opponent.displayName}'s profile in a new tab`}
          >
            <strong>{opponent.displayName}</strong>
          </Link>
          <span className="opponent-rating">{Math.round(opponent.rating)}</span>
        </div>
      )}

      <WordleNotice notice={moveNotice} />

      <div className="match-boards">
        <WordleBoard
          wordLength={view.wordLength}
          maxGuesses={view.maxGuesses}
          guesses={view.self.guesses}
          pendingInput={gameOver ? undefined : inputValue}
        />
        <OpponentWordleBoard
          displayName={opponent?.displayName}
          wordLength={view.wordLength}
          maxGuesses={view.maxGuesses}
          feedback={view.opponent.feedback}
          solved={view.opponent.solved}
        />
      </div>

      {view.mode === "fewest-guesses" && view.self.solved && !gameOver && (
        <p className="match-progress-note">
          Solved in {view.self.guesses.length} {view.self.guesses.length === 1 ? "guess" : "guesses"} — waiting for your opponent.
        </p>
      )}

      {view.mode === "fewest-guesses" && !view.self.solved && view.self.guessesRemaining === 0 && !gameOver && (
        <p className="match-progress-note">No guesses remaining — waiting for your opponent.</p>
      )}

      {!gameOver && <WordleKeyboard guesses={view.self.guesses} disabled={!canPlay || submittingGuess} onKey={handleKey} />}

      {confirmingExit && !gameOver && (
        <div className="confirm-backdrop" role="presentation" onClick={() => setConfirmingExit(false)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="forfeit-match-title"
            aria-describedby="forfeit-match-body"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="forfeit-match-title">Forfeit the match?</h2>
            <p id="forfeit-match-body" className="muted">
              {phase === "active"
                ? "Leaving now forfeits the match. Your opponent wins it and your rating drops."
                : "Leaving now forfeits the match. It is abandoned before the first move, so no rating changes."}
            </p>
            <div className="confirm-actions">
              <button className="btn-secondary" ref={keepPlayingButtonRef} onClick={() => setConfirmingExit(false)}>
                Keep playing
              </button>
              <button className="btn-danger" onClick={onExit}>
                Forfeit match
              </button>
            </div>
          </div>
        </div>
      )}

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
            {resultReason}
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
            Back to Wordle
          </button>
        </div>
      )}
    </div>
  );
}
