"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room, SeatReservation } from "@colyseus/sdk";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMatchHistory, getMe, type MatchHistoryEntry, type MeResponse } from "../lib/api";
import { getColyseusClient } from "../lib/colyseus";
import { saveActiveMatch } from "../lib/match-storage";
import { setPendingMatchRoom } from "../lib/pending-match";

type Phase = "idle" | "queueing" | "starting-solo";

function formatTime(milliseconds: number): string {
  const totalTenths = Math.floor(milliseconds / 100);
  return `${Math.floor(totalTenths / 600)}:${String(Math.floor((totalTenths % 600) / 10)).padStart(2, "0")}.${totalTenths % 10}`;
}

export function SpiderLobby() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [history, setHistory] = useState<MatchHistoryEntry[]>([]);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queueRoomRef = useRef<Room | null>(null);
  const queueCleanupRef = useRef<(() => void) | null>(null);

  const refresh = useCallback(async () => {
    const token = await getToken();
    const [profile, matches] = await Promise.all([getMe(token), getMatchHistory(token, "spider")]);
    setMe(profile);
    setHistory(matches);
  }, [getToken]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await refresh();
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "Failed to load Spider");
      }
    })();
    return () => {
      active = false;
    };
  }, [refresh]);

  useEffect(() => {
    return () => {
      const room = queueRoomRef.current;
      queueRoomRef.current = null;
      queueCleanupRef.current?.();
      queueCleanupRef.current = null;
      if (room) void room.leave().catch(() => undefined);
    };
  }, []);

  async function findMatch(): Promise<void> {
    setError(null);
    setQueueCount(null);
    setPhase("queueing");
    try {
      const client = getColyseusClient();
      const queueRoom = await client.joinOrCreate("spider_speed_matchmaking", { authToken: await getToken() });
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
          router.push(`/games/spider/match/${room.roomId}`);
        } catch (caught) {
          queueRoomRef.current = null;
          cleanupListeners();
          void queueRoom.leave().catch(() => undefined);
          setError(caught instanceof Error ? caught.message : "Failed to connect to the race");
          setPhase("idle");
        }
      });
      const handleLeave = () => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        setPhase("idle");
        if (!handedOff) setError("Matchmaking ended before a race was found");
      };
      const handleError = (_code: number, message?: string) => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        void queueRoom.leave().catch(() => undefined);
        setError(message ?? "Matchmaking connection error");
        setPhase("idle");
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
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to join matchmaking");
      setPhase("idle");
    }
  }

  function cancelQueue(): void {
    const room = queueRoomRef.current;
    queueRoomRef.current = null;
    queueCleanupRef.current?.();
    queueCleanupRef.current = null;
    if (room) void room.leave().catch(() => undefined);
    setPhase("idle");
    setQueueCount(null);
  }

  async function startSolo(): Promise<void> {
    setError(null);
    setPhase("starting-solo");
    try {
      const room = await getColyseusClient().create("spider_speed_solo", { authToken: await getToken() });
      setPendingMatchRoom(room);
      saveActiveMatch(room.roomId, room.reconnectionToken);
      router.push(`/games/spider/solo/${room.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to start a solo run");
      setPhase("idle");
    }
  }

  const rating = me?.ratings.find((entry) => entry.gameId === "spider" && entry.mode === "speed");
  const personalBest = me?.personalBests.find((entry) => entry.gameId === "spider" && entry.mode === "speed");

  return (
    <div className="stack">
      <Link className="back-link" href="/">← All games</Link>

      <section className="wordle-lobby-header">
        <div>
          <span className="eyebrow">Spider Sprint</span>
          <h1>Clear four runs. Fastest wins.</h1>
          <p className="muted">Every race uses the same guaranteed-solvable deal for both players. Build descending stacks, then complete King through Ace.</p>
        </div>
      </section>

      <section className="mode-grid spider-mode-grid" aria-label="Spider modes">
        <article className="mode-card mode-card-solo">
          <div className="mode-card-topline">
            <span className="mode-icon" aria-hidden="true">◎</span>
            <span className="mode-kicker">Personal best</span>
            <span className="mode-rating"><strong>{personalBest ? formatTime(personalBest.bestTimeMs) : "—"}</strong></span>
          </div>
          <h2>Solo</h2>
          <p>Practice the same speed rules on your own. Completed runs are server-timed and can set a personal best.</p>
          <button className="btn mode-button" onClick={startSolo} disabled={!me || phase !== "idle"}>
            {phase === "starting-solo" ? "Starting…" : "Start Solo Run"}
          </button>
        </article>

        <article className="mode-card mode-card-speed">
          <div className="mode-card-topline">
            <span className="mode-icon" aria-hidden="true">♠</span>
            <span className="mode-kicker">Ranked speed</span>
            <span className="mode-rating"><span>Rating</span><strong>{rating ? Math.round(rating.rating) : "—"}</strong></span>
          </div>
          <h2>Head-to-head</h2>
          <p>Race a similarly rated player on an identical board. Leaving never awards an instant win; if both leave, the race is a draw.</p>
          {phase === "queueing" ? (
            <div className="queue-status">
              <div className="muted">Searching <span className="spinner-dot" />{queueCount !== null && queueCount > 1 ? ` (${queueCount} queued)` : ""}</div>
              <button className="btn-secondary" onClick={cancelQueue}>Cancel</button>
            </div>
          ) : (
            <button className="btn mode-button" onClick={findMatch} disabled={!me || phase !== "idle"}>Find Speed Match</button>
          )}
        </article>
      </section>

      {error && <div className="card compact-card"><p className="error-text" style={{ margin: 0 }}>{error}</p></div>}

      <div className="card">
        <div className="history-heading">
          <h3>Spider history</h3>
          <p className="muted">Recent ranked speed races</p>
        </div>
        {history.length === 0 && <p className="muted">No Spider races yet — start one above.</p>}
        {history.map((entry) => {
          const opponent = entry.players.find((player) => player.userId !== me?.id);
          const isWinner = entry.players.find((player) => player.userId === me?.id)?.isWinner;
          const isDraw = entry.resultStatus === "draw";
          const outcomeClass = isDraw ? "pill-draw" : isWinner ? "pill-win" : "pill-loss";
          const outcomeLabel = isDraw ? "Draw" : isWinner ? "Win" : "Loss";
          const delta = entry.ratingAfter === null ? null : Math.round(entry.ratingAfter - entry.ratingBefore);
          return (
            <div className="history-row" key={entry.matchId}>
              <span className="history-opponent">
                {opponent ? <Link className="player-profile-link" href={`/players/${encodeURIComponent(opponent.userId)}`}>vs {opponent.displayName}</Link> : <span>vs unknown</span>}
                <span className="history-mode">Speed · {entry.resultReason?.replaceAll("-", " ") ?? entry.status.toLowerCase()}</span>
              </span>
              {entry.status === "COMPLETED" ? (
                <span className="row" style={{ gap: 8 }}><span className={`pill ${outcomeClass}`}>{outcomeLabel}</span>{delta !== null && <span className="muted">{delta >= 0 ? `+${delta}` : delta}</span>}</span>
              ) : <span className="muted">{entry.status.toLowerCase()}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
