"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room, SeatReservation } from "@colyseus/sdk";
import type { WordleMode } from "@smart-rot/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getColyseusClient } from "../lib/colyseus";
import { getMatchHistory, getMe, type MatchHistoryEntry, type MeResponse } from "../lib/api";
import { saveActiveMatch } from "../lib/match-storage";
import { setPendingMatchRoom } from "../lib/pending-match";

type Phase = "idle" | "queueing";

const WORDLE_MODES: Array<{
  id: WordleMode;
  title: string;
  shortLabel: string;
  description: string;
  detail: string;
  queueRoom: string;
}> = [
  {
    id: "fewest-guesses",
    title: "Fewest Guesses",
    shortLabel: "Fewest",
    description: "Solve efficiently",
    detail: "Both players finish the puzzle. The player who finds the word in fewer guesses wins.",
    queueRoom: "wordle_fewest_matchmaking",
  },
  {
    id: "speed",
    title: "Speed",
    shortLabel: "Speed",
    description: "Solve before your opponent",
    detail: "The first player to find the word wins. A five-minute server timer keeps the race moving.",
    queueRoom: "wordle_speed_matchmaking",
  },
];

function getMode(mode: WordleMode) {
  return WORDLE_MODES.find((entry) => entry.id === mode)!;
}

export function Lobby() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [history, setHistory] = useState<MatchHistoryEntry[]>([]);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [queueMode, setQueueMode] = useState<WordleMode | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queueRoomRef = useRef<Room | null>(null);
  const queueCleanupRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    const token = await getToken();
    const [meData, historyData] = await Promise.all([getMe(token), getMatchHistory(token)]);
    setMe(meData);
    setHistory(historyData);
  }, [getToken]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        await refresh();
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "Failed to load your profile");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // Leave any in-progress queue if the user navigates away or closes the tab
  // without clicking Cancel — releases the server-side session lock promptly
  // instead of waiting out its TTL.
  useEffect(() => {
    return () => {
      const queueRoom = queueRoomRef.current;
      queueRoomRef.current = null;
      queueCleanupRef.current?.();
      queueCleanupRef.current = null;
      if (queueRoom) void queueRoom.leave().catch(() => undefined);
    };
  }, []);

  async function findMatch(mode: WordleMode) {
    setError(null);
    setPhase("queueing");
    setQueueCount(null);
    setQueueMode(mode);
    try {
      const token = await getToken();
      const client = getColyseusClient();
      const queueRoom = await client.joinOrCreate(getMode(mode).queueRoom, { authToken: token });
      queueRoomRef.current = queueRoom;

      let handedOff = false;
      let consumingSeat = false;
      let cleanupListeners = () => undefined;
      const offClients = queueRoom.onMessage("clients", (count: number) => setQueueCount(count));
      const offSeat = queueRoom.onMessage("seat", async (reservation: SeatReservation) => {
        if (consumingSeat) return;
        consumingSeat = true;
        try {
          const room = await client.consumeSeatReservation(reservation);
          handedOff = true;
          queueRoomRef.current = null;
          cleanupListeners();
          queueRoom.send("confirm");
          setPendingMatchRoom(room);
          saveActiveMatch(room.roomId, room.reconnectionToken);
          router.push(`/match/${room.roomId}`);
        } catch (err) {
          queueRoomRef.current = null;
          cleanupListeners();
          void queueRoom.leave().catch(() => undefined);
          setError(err instanceof Error ? err.message : "Failed to connect to the match");
          setPhase("idle");
          setQueueMode(null);
        }
      });
      const handleLeave = () => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        setPhase("idle");
        setQueueMode(null);
        if (!handedOff) setError("Matchmaking ended before a match was found");
      };
      const handleError = (_code: number, message?: string) => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        void queueRoom.leave().catch(() => undefined);
        setError(message ?? "Matchmaking connection error");
        setPhase("idle");
        setQueueMode(null);
      };
      queueRoom.onLeave(handleLeave);
      queueRoom.onError(handleError);
      cleanupListeners = () => {
        offClients();
        offSeat();
        queueRoom.onLeave.remove(handleLeave);
        queueRoom.onError.remove(handleError);
        if (queueCleanupRef.current === cleanupListeners) queueCleanupRef.current = null;
      };
      queueCleanupRef.current = cleanupListeners;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join matchmaking");
      setPhase("idle");
      setQueueMode(null);
    }
  }

  function cancelQueue() {
    const queueRoom = queueRoomRef.current;
    queueRoomRef.current = null;
    queueCleanupRef.current?.();
    queueCleanupRef.current = null;
    if (queueRoom) void queueRoom.leave().catch(() => undefined);
    setPhase("idle");
    setQueueCount(null);
    setQueueMode(null);
  }

  return (
    <div className="stack">
      <Link className="back-link" href="/">
        ← All games
      </Link>

      <section className="wordle-lobby-header">
        <div>
          <span className="eyebrow">Ranked Wordle</span>
          <h1>Choose a mode</h1>
          <p className="muted">Each mode has its own rating and matches you against a nearby opponent in that ladder.</p>
        </div>
      </section>

      <section className="mode-grid" aria-label="Wordle modes">
        {WORDLE_MODES.map((mode) => {
          const searching = phase === "queueing" && queueMode === mode.id;
          const modeRating = me?.ratings.find((rating) => rating.gameId === "wordle" && rating.mode === mode.id);
          return (
            <article className={`mode-card mode-card-${mode.id}`} key={mode.id}>
              <div className="mode-card-topline">
                <span className="mode-icon" aria-hidden="true">
                  {mode.id === "speed" ? "◷" : "123"}
                </span>
                <span className="mode-kicker">{mode.description}</span>
                <span className="mode-rating" aria-label={`${mode.title} rating`}>
                  <span>Rating</span>
                  <strong>{modeRating ? Math.round(modeRating.rating) : "—"}</strong>
                </span>
              </div>
              <h2>{mode.title}</h2>
              <p>{mode.detail}</p>

              {searching ? (
                <div className="queue-status">
                  <div className="muted">
                    Searching <span className="spinner-dot" />
                    {queueCount !== null && queueCount > 1 ? ` (${queueCount} in this pool)` : ""}
                  </div>
                  <button className="btn-secondary" onClick={cancelQueue}>
                    Cancel
                  </button>
                </div>
              ) : (
                <button className="btn mode-button" onClick={() => findMatch(mode.id)} disabled={!me || phase === "queueing"}>
                  Find {mode.shortLabel} Match
                </button>
              )}
            </article>
          );
        })}
      </section>

      {error && (
        <div className="card compact-card">
          <p className="error-text" style={{ margin: 0 }}>
            {error}
          </p>
        </div>
      )}

      <div className="card">
        <div className="history-heading">
          <div>
            <h3>Wordle history</h3>
            <p className="muted">Recent matches from both modes</p>
          </div>
        </div>
        {history.length === 0 && <p className="muted">No Wordle matches yet — choose a mode above.</p>}
        {history.map((entry) => {
          const opponent = entry.players.find((p) => p.userId !== me?.id);
          const isWinner = entry.players.find((p) => p.userId === me?.id)?.isWinner;
          const outcomeClass = entry.resultStatus === "draw" ? "pill-draw" : isWinner ? "pill-win" : "pill-loss";
          const outcomeLabel = entry.resultStatus === "draw" ? "Draw" : isWinner ? "Win" : "Loss";
          const delta = entry.ratingAfter !== null ? Math.round(entry.ratingAfter - entry.ratingBefore) : null;
          return (
            <div className="history-row" key={entry.matchId}>
              <span className="history-opponent">
                <span>vs {opponent?.displayName ?? "unknown"}</span>
                <span className="history-mode">{entry.mode === "fewest-guesses" ? "Fewest guesses" : "Speed"}</span>
              </span>
              {entry.status === "COMPLETED" ? (
                <span className="row" style={{ gap: 8 }}>
                  <span className={`pill ${outcomeClass}`}>{outcomeLabel}</span>
                  {delta !== null && <span className="muted">{delta >= 0 ? `+${delta}` : delta}</span>}
                </span>
              ) : (
                <span className="muted">{entry.status.toLowerCase()}</span>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
