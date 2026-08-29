"use client";

import type { Room } from "@colyseus/sdk";
import type {
  MatchOpponentInfo,
  MatchResult,
  PlayerId,
  SoloResultMessage,
  SpiderMove,
  SpiderStateView,
} from "@smart-rot/shared-types";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { clearActiveMatch } from "../lib/match-storage";
import { GameHelpDialog } from "./GameHelpDialog";
import { SpiderBoard } from "./SpiderBoard";
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

interface RankedResultMessage {
  result: MatchResult;
  ratings: Record<PlayerId, { before: number; after: number }> | null;
  persisted: boolean;
}

function formatTime(milliseconds: number): string {
  const totalTenths = Math.max(0, Math.floor(milliseconds / 100));
  return `${Math.floor(totalTenths / 600)}:${String(Math.floor((totalTenths % 600) / 10)).padStart(2, "0")}.${totalTenths % 10}`;
}

export function SpiderGame({
  room,
  kind,
  currentUserId,
  onExit,
}: {
  room: Room;
  kind: "ranked" | "solo";
  currentUserId?: string;
  onExit: () => void;
}) {
  const [view, setView] = useState<SpiderStateView | null>(null);
  const [phase, setPhase] = useState<"waiting" | "countdown" | "active">("waiting");
  const [opponent, setOpponent] = useState<MatchOpponentInfo | null>(null);
  const [opponentLeft, setOpponentLeft] = useState(false);
  const [countdownClock, setCountdownClock] = useState<SyncedCountdown | null>(null);
  const [runClock, setRunClock] = useState<SyncedClock | null>(null);
  const [clockNow, setClockNow] = useState(Date.now);
  const [rankedResult, setRankedResult] = useState<RankedResultMessage | null>(null);
  const [soloResult, setSoloResult] = useState<SoloResultMessage | null>(null);
  const [notice, setNotice] = useState<WordleNoticeMessage | null>(null);
  const [pendingMove, setPendingMove] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const [confirmingExit, setConfirmingExit] = useState(false);
  const [showingHelp, setShowingHelp] = useState(false);
  const moveCountRef = useRef<number | null>(null);
  const noticeIdRef = useRef(0);
  const keepPlayingRef = useRef<HTMLButtonElement | null>(null);

  const gameOver = rankedResult !== null || soloResult !== null;

  useEffect(() => {
    moveCountRef.current = null;
    const offPhase = room.onMessage("phase", (next: "waiting" | "countdown" | "active") => {
      setPhase(next);
      if (next === "active") setCountdownClock(null);
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
    const offState = room.onMessage("state", (payload: SpiderStateView) => {
      if (moveCountRef.current === null || payload.self.moveCount !== moveCountRef.current) {
        setPendingMove(false);
        setNotice(null);
      }
      moveCountRef.current = payload.self.moveCount;
      setView(payload);
    });
    const offOpponent = room.onMessage("opponent", (payload: MatchOpponentInfo) => setOpponent(payload));
    const offPlayerLeft = room.onMessage("playerLeft", (payload: { playerId: string }) => {
      if (!currentUserId || payload.playerId !== currentUserId) setOpponentLeft(true);
    });
    const offResult = room.onMessage("result", (payload: RankedResultMessage) => {
      setRankedResult(payload);
      setPendingMove(false);
      setConnectionLost(false);
      clearActiveMatch();
    });
    const offSoloResult = room.onMessage("soloResult", (payload: SoloResultMessage) => {
      setSoloResult(payload);
      setPendingMove(false);
      setConnectionLost(false);
      clearActiveMatch();
    });
    const offRejected = room.onMessage("moveRejected", (payload: { message: string }) => {
      setPendingMove(false);
      setNotice({ id: ++noticeIdRef.current, message: payload.message });
    });
    const handleDrop = () => {
      setConnectionLost(true);
      setPendingMove(false);
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
      offOpponent();
      offPlayerLeft();
      offResult();
      offSoloResult();
      offRejected();
      room.onDrop.remove(handleDrop);
      room.onReconnect.remove(handleReconnect);
    };
  }, [currentUserId, room]);

  useEffect(() => {
    if (!notice) return;
    const id = notice.id;
    const timeout = window.setTimeout(() => setNotice((current) => current?.id === id ? null : current), 2_200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    if (gameOver || !((phase === "countdown" && countdownClock) || (phase === "active" && runClock))) return;
    const interval = window.setInterval(() => setClockNow(Date.now()), 100);
    return () => window.clearInterval(interval);
  }, [countdownClock, gameOver, phase, runClock]);

  useEffect(() => {
    if (!confirmingExit) return;
    keepPlayingRef.current?.focus();
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setConfirmingExit(false);
      }
    };
    window.addEventListener("keydown", handleEscape);
    return () => window.removeEventListener("keydown", handleEscape);
  }, [confirmingExit]);

  function showLocalError(message: string): void {
    setNotice({ id: ++noticeIdRef.current, message });
  }

  function submitMove(move: SpiderMove): void {
    if (!view || phase !== "active" || gameOver || connectionLost || pendingMove) return;
    setPendingMove(true);
    setNotice(null);
    room.send("move", move);
  }

  function requestExit(): void {
    if (gameOver) onExit();
    else setConfirmingExit(true);
  }

  if (!view) return <div className="card"><p className="muted">Preparing Spider board <span className="spinner-dot" /></p></div>;

  const countdownRemaining = countdownClock ? Math.max(0, countdownClock.endsAt - (clockNow + countdownClock.offsetMs)) : null;
  const countdownNumber = countdownRemaining === null ? 3 : Math.max(1, Math.ceil(countdownRemaining / 1000));
  const elapsed = soloResult?.elapsedMs ?? (runClock ? Math.max(0, clockNow + runClock.offsetMs - runClock.startedAt) : 0);
  const canPlay = phase === "active" && !gameOver && !connectionLost && !confirmingExit && !showingHelp && !view.self.solved;
  const rankedMatchResult = rankedResult?.result;
  const won = rankedMatchResult?.status === "win" && rankedMatchResult.winnerId === currentUserId;
  const lost = rankedMatchResult?.status === "win" && rankedMatchResult.winnerId !== currentUserId;
  const myRating = currentUserId ? rankedResult?.ratings?.[currentUserId] : undefined;
  const resultTitle = soloResult
    ? soloResult.isPersonalBest ? "New personal best!" : soloResult.solved ? "Run complete" : "Run over"
    : rankedMatchResult?.status === "aborted" ? "Race aborted" : won ? "You won!" : lost ? "You lost" : "Draw";
  const resultReason = rankedMatchResult?.reason === "solved"
    ? "Fastest clear"
    : rankedMatchResult?.reason === "both-left"
      ? "Both players left the race"
      : rankedMatchResult?.reason?.replaceAll("-", " ");

  return (
    <div className="card match-card spider-match-card">
      {phase === "countdown" && !gameOver && <div className="round-countdown" role="status" aria-live="assertive"><span>Get ready</span><strong key={countdownNumber}>{countdownNumber}</strong></div>}
      {connectionLost && !gameOver && <p className="error-text solo-status">Connection lost — reconnecting…</p>}
      {kind === "ranked" && phase === "waiting" && !gameOver && <p className="muted solo-status">Waiting for your opponent <span className="spinner-dot" /></p>}

      <div className="match-toolbar spider-toolbar">
        <button className="match-back-button" onClick={requestExit}><span aria-hidden="true">←</span> Back</button>
        <span className="match-mode-badge match-mode-speed">{view.mode.replace("-", " ")} · {kind === "solo" ? "Solo" : "Ranked"}</span>
        <div className="match-toolbar-actions">
          <button type="button" className="match-help-button" onClick={() => setShowingHelp(true)}><span aria-hidden="true">?</span> Help</button>
          <span className="match-timer"><span aria-hidden="true">◷</span> {formatTime(elapsed)}</span>
        </div>
      </div>

      {kind === "ranked" && opponent && (
        <div className="opponent-identity">
          <span>vs</span>
          <Link className="player-profile-link" href={`/players/${encodeURIComponent(opponent.userId)}`} target="_blank" rel="noreferrer"><strong>{opponent.displayName}</strong></Link>
          <span className="opponent-rating">{Math.round(opponent.rating)}</span>
        </div>
      )}
      {opponentLeft && !gameOver && <p className="spider-departure-note">Your opponent left. You can still finish; if you leave too, the race is a draw.</p>}

      <div className="spider-progress" aria-label="Race progress">
        <div><span>You</span><strong>{view.self.completedRuns}/{view.targetRuns}</strong><small>{view.self.moveCount} actions · {view.self.stock.length} deals left</small></div>
        {kind === "ranked" && <div><span>{opponent?.displayName ?? "Opponent"}</span><strong>{view.opponent.completedRuns}/{view.targetRuns}</strong><small>{view.opponent.moveCount} actions · {view.opponent.remainingDeals} deals left</small></div>}
      </div>

      <WordleNotice notice={notice} />
      <SpiderBoard player={view.self} disabled={!canPlay} pending={pendingMove} showActions={!gameOver} onMove={submitMove} onLocalError={showLocalError} />

      {showingHelp && !gameOver && (
        <GameHelpDialog
          eyebrow={`${view.mode.replace("-", " ")} · ${kind === "solo" ? "Solo" : "Ranked"}`}
          title="How to play Spider"
          onClose={() => setShowingHelp(false)}
        >
          <section>
            <h3>Goal</h3>
            <p>Clear all eight complete, same-suit runs from King down to Ace. A finished run leaves the tableau automatically.</p>
          </section>
          <section>
            <h3>Move cards</h3>
            <ul>
              <li>Tap a face-up card to make its best valid move: same suit first, then another suit, then an empty column, searching left to right.</li>
              <li>Drag a card when you want to choose the destination yourself. A descending same-suit stack moves together.</li>
              <li>You may place a card or stack on the next higher rank. Any card or valid stack may fill an empty column.</li>
            </ul>
          </section>
          <section>
            <h3>Stock, hints, and take backs</h3>
            <ul>
              <li>Click the stock pile above the tableau to deal one new card to every column, including empty columns.</li>
              <li>Hints cycle through moves that reveal cards or build same-suit runs, then suggest an empty column or another deal.</li>
              <li>Hints and take backs are unlimited.</li>
            </ul>
          </section>
          <section>
            <h3>This mode</h3>
            <p>
              {view.mode === "1-suit"
                ? "All cards use one suit, so every descending stack can move together."
                : `${view.mode.replace("-", " ")} mixes suits. Cards of different suits can be placed together, but only a same-suit descending stack moves as one.`}
              {kind === "solo"
                ? " Finish as quickly as possible to set a personal best."
                : " Both players receive the same solvable board; the fastest clear wins. Leaving alone is not an automatic loss, and if both players leave the race is a draw."}
            </p>
          </section>
        </GameHelpDialog>
      )}

      {confirmingExit && !gameOver && (
        <div className="confirm-backdrop" role="presentation" onClick={() => setConfirmingExit(false)}>
          <div className="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="leave-spider-title" aria-describedby="leave-spider-body" onClick={(event) => event.stopPropagation()}>
            <h2 id="leave-spider-title">Leave this {kind === "solo" ? "run" : "race"}?</h2>
            <p id="leave-spider-body" className="muted">
              {kind === "solo"
                ? "This run ends and its time is discarded."
                : "This is not an automatic loss. Your opponent may keep playing; if they leave too, the race ends in a draw."}
            </p>
            <div className="confirm-actions">
              <button className="btn-secondary" ref={keepPlayingRef} onClick={() => setConfirmingExit(false)}>Keep playing</button>
              <button className="btn-danger" onClick={onExit}>Leave {kind === "solo" ? "run" : "race"}</button>
            </div>
          </div>
        </div>
      )}

      {gameOver && (
        <div className="match-result spider-result">
          <h2>{resultTitle}</h2>
          {soloResult?.solved && soloResult.elapsedMs !== null && <p className="muted">Time: {formatTime(soloResult.elapsedMs)}</p>}
          {soloResult?.bestTimeMs !== null && soloResult?.bestTimeMs !== undefined && <p className="muted">Personal best: {formatTime(soloResult.bestTimeMs)}</p>}
          {resultReason && <p className="muted">{resultReason}</p>}
          {myRating && <p className="muted">Rating: {Math.round(myRating.before)} → {Math.round(myRating.after)} ({myRating.after - myRating.before >= 0 ? "+" : ""}{Math.round(myRating.after - myRating.before)})</p>}
          {((soloResult && !soloResult.persisted) || (rankedResult && !rankedResult.persisted)) && <p className="error-text">The server could not save this result.</p>}
          <button className="btn-secondary" onClick={onExit} style={{ marginTop: 16 }}>Back to Spider</button>
        </div>
      )}
    </div>
  );
}
