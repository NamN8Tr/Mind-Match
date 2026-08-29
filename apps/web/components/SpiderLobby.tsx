"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room, SeatReservation } from "@colyseus/sdk";
import type { SpiderMode } from "@smart-rot/shared-types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getMatchHistory, getMe, type MatchHistoryEntry, type MeResponse } from "../lib/api";
import { getColyseusClient } from "../lib/colyseus";
import { saveActiveMatch } from "../lib/match-storage";
import { setPendingMatchRoom } from "../lib/pending-match";

type Phase = "idle" | "queueing" | "starting-solo";
type PlayKind = "solo" | "ranked";

const SPIDER_VARIANTS: Array<{ mode: SpiderMode; title: string; suits: string; description: string }> = [
  { mode: "1-suit", title: "1 Suit", suits: "♠", description: "A clean introduction with every card in one suit." },
  { mode: "2-suit", title: "2 Suits", suits: "♠ ♥", description: "Same-rank joins are easy; movable runs must match suits." },
  { mode: "3-suit", title: "3 Suits", suits: "♠ ♥ ♦", description: "More planning and fewer interchangeable sequences." },
  { mode: "4-suit", title: "4 Suits", suits: "♠ ♥ ♦ ♣", description: "The full challenge with all four suits in play." },
];

function formatTime(milliseconds: number): string {
  const totalTenths = Math.floor(milliseconds / 100);
  return `${Math.floor(totalTenths / 600)}:${String(Math.floor((totalTenths % 600) / 10)).padStart(2, "0")}.${totalTenths % 10}`;
}

function roomKey(mode: SpiderMode): string {
  return mode.replace("-", "_");
}

function modeLabel(mode: string): string {
  if (mode === "speed") return "1 Suit";
  const count = Number(mode[0]);
  return Number.isFinite(count) ? `${count} ${count === 1 ? "Suit" : "Suits"}` : mode;
}

export function SpiderLobby() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [selectedKind, setSelectedKind] = useState<PlayKind | null>(null);
  const [activeMode, setActiveMode] = useState<SpiderMode | null>(null);
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

  async function findMatch(mode: SpiderMode): Promise<void> {
    setError(null);
    setQueueCount(null);
    setActiveMode(mode);
    setPhase("queueing");
    try {
      const client = getColyseusClient();
      const queueRoom = await client.joinOrCreate(`spider_${roomKey(mode)}_matchmaking`, { authToken: await getToken() });
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
          setActiveMode(null);
        }
      });
      const handleLeave = () => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        setPhase("idle");
        setActiveMode(null);
        if (!handedOff) setError("Matchmaking ended before a race was found");
      };
      const handleError = (_code: number, message?: string) => {
        if (queueRoomRef.current !== queueRoom) return;
        queueRoomRef.current = null;
        cleanupListeners();
        void queueRoom.leave().catch(() => undefined);
        setError(message ?? "Matchmaking connection error");
        setPhase("idle");
        setActiveMode(null);
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
      setActiveMode(null);
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
    setActiveMode(null);
  }

  async function startSolo(mode: SpiderMode): Promise<void> {
    setError(null);
    setActiveMode(mode);
    setPhase("starting-solo");
    try {
      const room = await getColyseusClient().create(`spider_${roomKey(mode)}_solo`, { authToken: await getToken() });
      setPendingMatchRoom(room);
      saveActiveMatch(room.roomId, room.reconnectionToken);
      router.push(`/games/spider/solo/${room.roomId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to start a solo run");
      setPhase("idle");
      setActiveMode(null);
    }
  }

  return (
    <div className="stack">
      <Link className="back-link" href="/">← All games</Link>

      <section className="wordle-lobby-header">
        <div>
          <span className="eyebrow">Spider Sprint</span>
          <h1>{selectedKind ? `Choose ${selectedKind === "solo" ? "a solo" : "a ranked"} challenge.` : "Clear eight runs. Fastest wins."}</h1>
          <p className="muted">
            {selectedKind
              ? "Choose how many suits are in the deal. Every variant is guaranteed solvable."
              : "Pick Solo or Ranked first, then choose from 1-, 2-, 3-, or 4-suit Spider."}
          </p>
        </div>
      </section>

      {!selectedKind ? (
        <section className="mode-grid spider-mode-grid" aria-label="Spider play types">
          <article className="mode-card mode-card-solo spider-entry-card">
            <div className="mode-card-topline"><span className="mode-icon" aria-hidden="true">◎</span><span className="mode-kicker">Personal records</span></div>
            <h2>Solo</h2>
            <p>Practice any suit count on your own. Solo and ranked clears both feed the same personal-best clock.</p>
            <button className="btn mode-button" onClick={() => setSelectedKind("solo")} disabled={!me}>Choose Solo Mode</button>
          </article>
          <article className="mode-card mode-card-speed spider-entry-card">
            <div className="mode-card-topline"><span className="mode-icon" aria-hidden="true">♠</span><span className="mode-kicker">Four ranked ladders</span></div>
            <h2>Ranked</h2>
            <p>Race a similarly rated player on an identical board. Each suit count has its own rating.</p>
            <button className="btn mode-button" onClick={() => setSelectedKind("ranked")} disabled={!me}>Choose Ranked Mode</button>
          </article>
        </section>
      ) : (
        <section aria-label={`${selectedKind} Spider suit modes`}>
          <button className="spider-mode-back" onClick={() => setSelectedKind(null)} disabled={phase !== "idle"}>← Solo or Ranked</button>
          <div className="spider-variant-grid">
            {SPIDER_VARIANTS.map((variant) => {
              const isActive = activeMode === variant.mode;
              const rating = me?.ratings.find((entry) => entry.gameId === "spider" && entry.mode === variant.mode);
              const best = me?.personalBests.find(
                (entry) =>
                  entry.gameId === "spider" &&
                  (entry.mode === variant.mode || (variant.mode === "1-suit" && entry.mode === "speed")),
              );
              return (
                <article className={`spider-variant-card spider-variant-${variant.mode}`} key={variant.mode}>
                  <div className="spider-variant-topline">
                    <span className="spider-suit-set" aria-label={variant.title}>{variant.suits}</span>
                    <span className="mode-rating">
                      <span>{selectedKind === "solo" ? "Best" : "Rating"}</span>
                      <strong>{selectedKind === "solo" ? (best ? formatTime(best.bestTimeMs) : "—") : (rating ? Math.round(rating.rating) : "—")}</strong>
                    </span>
                  </div>
                  <h2>{variant.title}</h2>
                  <p>{variant.description}</p>
                  {selectedKind === "ranked" && phase === "queueing" && isActive ? (
                    <div className="queue-status"><div className="muted">Searching <span className="spinner-dot" />{queueCount !== null && queueCount > 1 ? ` (${queueCount} queued)` : ""}</div><button className="btn-secondary" onClick={cancelQueue}>Cancel</button></div>
                  ) : (
                    <button
                      className="btn mode-button"
                      onClick={() => selectedKind === "solo" ? startSolo(variant.mode) : findMatch(variant.mode)}
                      disabled={!me || phase !== "idle"}
                    >
                      {selectedKind === "solo" && phase === "starting-solo" && isActive
                        ? "Starting…"
                        : selectedKind === "solo"
                          ? `Play ${variant.title}`
                          : `Find ${variant.title} Match`}
                    </button>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {error && <div className="card compact-card"><p className="error-text" style={{ margin: 0 }}>{error}</p></div>}

      <div className="card">
        <div className="history-heading"><h3>Spider history</h3><p className="muted">Recent ranked races across all suit modes</p></div>
        {history.length === 0 && <p className="muted">No Spider races yet — choose a mode above.</p>}
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
                <span className="history-mode">{modeLabel(entry.mode)} · {entry.resultReason?.replaceAll("-", " ") ?? entry.status.toLowerCase()}</span>
              </span>
              {entry.status === "COMPLETED" ? <span className="row" style={{ gap: 8 }}><span className={`pill ${outcomeClass}`}>{outcomeLabel}</span>{delta !== null && <span className="muted">{delta >= 0 ? `+${delta}` : delta}</span>}</span> : <span className="muted">{entry.status.toLowerCase()}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}
