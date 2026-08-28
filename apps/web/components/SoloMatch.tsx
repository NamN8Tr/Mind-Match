"use client";

import type { Room } from "@colyseus/sdk";
import type { SoloResultMessage, WordleMove, WordleStateView } from "@smart-rot/shared-types";
import { useCallback, useEffect, useRef, useState } from "react";
import { clearActiveMatch } from "../lib/match-storage";
import { WordleBoard } from "./WordleBoard";
import { WordleKeyboard } from "./WordleKeyboard";
import { WordleNotice, type WordleNoticeMessage } from "./WordleNotice";

interface ClockMessage {
  startedAt: number;
  deadlineAt: number;
  serverNow: number;
}

interface CountdownMessage {
  endsAt: number;
  serverNow: number;
}

interface SyncedClock extends ClockMessage {
  offsetMs: number;
}

interface SyncedCountdown extends CountdownMessage {
  offsetMs: number;
}

function formatTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
  const minutes = Math.floor(totalTenths / 600);
  const seconds = Math.floor((totalTenths % 600) / 10);
  return `${minutes}:${String(seconds).padStart(2, "0")}.${totalTenths % 10}`;
}

export function SoloMatch({ room, onExit }: { room: Room; onExit: () => void }) {
  const [view, setView] = useState<WordleStateView | null>(null);
  const [phase, setPhase] = useState<"waiting" | "countdown" | "active">("waiting");
  const [countdownClock, setCountdownClock] = useState<SyncedCountdown | null>(null);
  const [runClock, setRunClock] = useState<SyncedClock | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [result, setResult] = useState<SoloResultMessage | null>(null);
  const [inputValue, setInputValue] = useState("");
  const [moveNotice, setMoveNotice] = useState<WordleNoticeMessage | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const guessCountRef = useRef<number | null>(null);
  const abandonButtonRef = useRef<HTMLButtonElement | null>(null);
  const moveNoticeIdRef = useRef(0);

  useEffect(() => {
    guessCountRef.current = null;
    const offPhase = room.onMessage("phase", (nextPhase: "waiting" | "countdown" | "active") => {
      setPhase(nextPhase);
      if (nextPhase === "active") setCountdownClock(null);
    });
    const offCountdown = room.onMessage("countdown", (payload: CountdownMessage) => {
      const receivedAt = Date.now();
      setCountdownClock({ ...payload, offsetMs: payload.serverNow - receivedAt });
      setClockNow(receivedAt);
    });
    const offClock = room.onMessage("clock", (payload: ClockMessage) => {
      const receivedAt = Date.now();
      setRunClock({ ...payload, offsetMs: payload.serverNow - receivedAt });
      setClockNow(receivedAt);
    });
    const offState = room.onMessage("state", (payload: WordleStateView) => {
      const previousCount = guessCountRef.current;
      const nextCount = payload.self.guesses.length;
      guessCountRef.current = nextCount;
      setView(payload);
      if (previousCount === null || nextCount > previousCount) {
        setInputValue("");
        setMoveNotice(null);
        setSubmitting(false);
      }
    });
    const offResult = room.onMessage("soloResult", (payload: SoloResultMessage) => {
      setResult(payload);
      setConfirmingExit(false);
      setSubmitting(false);
      setConnectionLost(false);
      clearActiveMatch();
    });
    const offRejected = room.onMessage("moveRejected", (payload: { message: string }) => {
      setMoveNotice({ id: ++moveNoticeIdRef.current, message: payload.message });
      setSubmitting(false);
    });
    const handleDrop = () => {
      setConnectionLost(true);
      setSubmitting(false);
    };
    const handleReconnect = () => {
      setConnectionLost(false);
      room.send("ready");
    };
    room.onDrop(handleDrop);
    room.onReconnect(handleReconnect);
    room.send("ready");

    return () => {
      offPhase();
      offCountdown();
      offClock();
      offState();
      offResult();
      offRejected();
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
    const ticking = (phase === "countdown" && countdownClock) || (phase === "active" && runClock);
    if (!ticking || result) return;
    const interval = window.setInterval(() => setClockNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [countdownClock, phase, result, runClock]);

  const canPlay =
    view !== null &&
    phase === "active" &&
    result === null &&
    !confirmingExit &&
    !connectionLost &&
    !view.self.solved &&
    view.self.guessesRemaining > 0 &&
    !view.revealedAnswer;

  const handleKey = useCallback(
    (rawKey: string) => {
      if (!canPlay || !view || submitting) return;
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
        setSubmitting(true);
        room.send("move", move);
      } else if (key === "BACKSPACE" || key === "DELETE") {
        setInputValue((current) => current.slice(0, -1));
      } else if (/^[A-Z]$/.test(key)) {
        setInputValue((current) => (current.length < view.wordLength ? `${current}${key.toLowerCase()}` : current));
      }
    },
    [canPlay, inputValue, room, submitting, view],
  );

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (!/^[a-zA-Z]$/.test(event.key) && !["Enter", "Backspace", "Delete"].includes(event.key)) return;
      if (!canPlay || submitting) return;
      event.preventDefault();
      handleKey(event.key);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [canPlay, handleKey, submitting]);

  useEffect(() => {
    if (!confirmingExit) return;
    abandonButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmingExit(false);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [confirmingExit]);

  // Once the run is over there is nothing left to abandon, so the back button
  // leaves immediately rather than asking about a run that already ended.
  function requestExit(): void {
    if (result) {
      onExit();
      return;
    }
    setConfirmingExit(true);
  }

  if (!view) {
    return (
      <div className="card">
        <p className="muted">Preparing solo run <span className="spinner-dot" /></p>
      </div>
    );
  }

  const countdownRemaining = countdownClock
    ? Math.max(0, countdownClock.endsAt - (clockNow + countdownClock.offsetMs))
    : null;
  const countdownNumber = countdownRemaining === null ? 3 : Math.max(1, Math.ceil(countdownRemaining / 1000));
  const elapsed = result?.elapsedMs ?? (runClock ? Math.max(0, clockNow + runClock.offsetMs - runClock.startedAt) : 0);

  return (
    <div className="card match-card">
      {phase === "countdown" && !result && (
        <div className="round-countdown" role="status" aria-live="assertive">
          <span>Get ready</span>
          <strong key={countdownNumber}>{countdownNumber}</strong>
        </div>
      )}
      {connectionLost && !result && <p className="error-text solo-status">Connection lost — reconnecting…</p>}
      <div className="match-toolbar">
        <button className="match-back-button" onClick={requestExit}>
          <span aria-hidden="true">←</span> Back
        </button>
        <span className="match-mode-badge match-mode-speed">Solo</span>
        <span className="match-timer"><span aria-hidden="true">◷</span> {formatTime(elapsed)}</span>
      </div>
      <WordleNotice notice={moveNotice} />
      <WordleBoard
        wordLength={view.wordLength}
        maxGuesses={view.maxGuesses}
        guesses={view.self.guesses}
        pendingInput={result ? undefined : inputValue}
      />
      {!result && <WordleKeyboard guesses={view.self.guesses} disabled={!canPlay || submitting} onKey={handleKey} />}

      {confirmingExit && !result && (
        <div className="confirm-backdrop" role="presentation" onClick={() => setConfirmingExit(false)}>
          <div
            className="confirm-dialog"
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="abandon-run-title"
            aria-describedby="abandon-run-body"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 id="abandon-run-title">Abandon this run?</h2>
            <p id="abandon-run-body" className="muted">
              The run ends here and the time is discarded — it cannot set a personal best.
            </p>
            <div className="confirm-actions">
              <button className="btn-secondary" ref={abandonButtonRef} onClick={() => setConfirmingExit(false)}>
                Keep playing
              </button>
              <button className="btn-danger" onClick={onExit}>
                Abandon run
              </button>
            </div>
          </div>
        </div>
      )}

      {result && (
        <div className="match-result">
          <h2>{result.isPersonalBest ? "New personal best!" : result.solved ? "Run complete" : "Run over"}</h2>
          <p className="muted">
            {result.solved && result.elapsedMs !== null ? `Time: ${formatTime(result.elapsedMs)}` : "The puzzle was not solved."}
          </p>
          {result.bestTimeMs !== null && <p className="muted">Personal best: {formatTime(result.bestTimeMs)}</p>}
          {view.revealedAnswer && <p className="muted">The word was <strong>{view.revealedAnswer}</strong>.</p>}
          {!result.persisted && <p className="error-text">The server could not save this personal best.</p>}
          <button className="btn-secondary" onClick={onExit} style={{ marginTop: 16 }}>Back to Wordle</button>
        </div>
      )}
    </div>
  );
}
