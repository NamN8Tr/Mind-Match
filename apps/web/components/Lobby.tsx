"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room, SeatReservation } from "@colyseus/sdk";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { getColyseusClient } from "../lib/colyseus";
import { getMatchHistory, getMe, type MatchHistoryEntry, type MeResponse } from "../lib/api";
import { saveActiveMatch } from "../lib/match-storage";
import { setPendingMatchRoom } from "../lib/pending-match";

type Phase = "idle" | "queueing";

export function Lobby() {
  const { getToken } = useAuth();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [me, setMe] = useState<MeResponse | null>(null);
  const [history, setHistory] = useState<MatchHistoryEntry[]>([]);
  const [queueCount, setQueueCount] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const queueRoomRef = useRef<Room | null>(null);

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
      queueRoomRef.current?.leave();
      queueRoomRef.current = null;
    };
  }, []);

  async function findMatch() {
    setError(null);
    setPhase("queueing");
    setQueueCount(null);
    try {
      const token = await getToken();
      const client = getColyseusClient();
      const queueRoom = await client.joinOrCreate("wordle_matchmaking", { authToken: token });
      queueRoomRef.current = queueRoom;

      queueRoom.onMessage("clients", (count: number) => setQueueCount(count));
      queueRoom.onMessage("seat", async (reservation: SeatReservation) => {
        try {
          const room = await client.consumeSeatReservation(reservation);
          queueRoom.send("confirm");
          queueRoomRef.current = null;
          setPendingMatchRoom(room);
          saveActiveMatch(room.roomId, room.reconnectionToken);
          router.push(`/match/${room.roomId}`);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Failed to connect to the match");
          setPhase("idle");
        }
      });
      queueRoom.onLeave(() => {
        queueRoomRef.current = null;
      });
      queueRoom.onError((_code: number, message?: string) => {
        setError(message ?? "Matchmaking connection error");
        setPhase("idle");
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to join matchmaking");
      setPhase("idle");
    }
  }

  function cancelQueue() {
    queueRoomRef.current?.leave();
    queueRoomRef.current = null;
    setPhase("idle");
    setQueueCount(null);
  }

  const wordleRating = me?.ratings.find((r) => r.gameId === "wordle");

  return (
    <div className="stack">
      <div className="card">
        <div className="row-between">
          <div>
            <div className="muted">Wordle rating</div>
            {wordleRating ? (
              <>
                <div className="rating-figure">{Math.round(wordleRating.rating)}</div>
                <div className="rating-deviation">±{Math.round(wordleRating.deviation)}</div>
              </>
            ) : (
              <div className="muted">Loading…</div>
            )}
          </div>

          {phase === "idle" && (
            <button className="btn" onClick={findMatch} disabled={!me}>
              Find Match
            </button>
          )}
          {phase === "queueing" && (
            <div className="stack" style={{ alignItems: "flex-end" }}>
              <div className="muted">
                Searching for an opponent <span className="spinner-dot" />
                {queueCount !== null && queueCount > 1 ? ` (${queueCount} in this pool)` : ""}
              </div>
              <button className="btn-secondary" onClick={cancelQueue}>
                Cancel
              </button>
            </div>
          )}
        </div>
        {error && <p className="error-text" style={{ marginTop: 12 }}>{error}</p>}
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Match history</h3>
        {history.length === 0 && <p className="muted">No matches yet — find one above!</p>}
        {history.map((entry) => {
          const opponent = entry.players.find((p) => p.userId !== me?.id);
          const isWinner = entry.players.find((p) => p.userId === me?.id)?.isWinner;
          const outcomeClass = entry.resultStatus === "draw" ? "pill-draw" : isWinner ? "pill-win" : "pill-loss";
          const outcomeLabel = entry.resultStatus === "draw" ? "Draw" : isWinner ? "Win" : "Loss";
          const delta = entry.ratingAfter !== null ? Math.round(entry.ratingAfter - entry.ratingBefore) : null;
          return (
            <div className="history-row" key={entry.matchId}>
              <span>vs {opponent?.displayName ?? "unknown"}</span>
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
