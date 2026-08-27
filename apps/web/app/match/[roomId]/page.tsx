"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room } from "@colyseus/sdk";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Match } from "../../../components/Match";
import { getMe } from "../../../lib/api";
import { getColyseusClient } from "../../../lib/colyseus";
import { clearActiveMatch, loadActiveMatch, saveActiveMatch } from "../../../lib/match-storage";
import { takePendingMatchRoom } from "../../../lib/pending-match";

/**
 * The canonical match URL. Three ways to end up connected here, tried in order:
 *
 * 1. Same-tab handoff from the Lobby's matchmaking flow — the room is already
 *    connected (lib/pending-match), so this is instant.
 * 2. A reconnection token saved to sessionStorage on first connect — used
 *    after a page refresh, via Colyseus's own reconnect protocol. The server
 *    holds the seat open for a grace period (see RECONNECT_GRACE_SECONDS in
 *    create-game-room.ts) specifically for this.
 * 3. A fresh authenticated join by room id — WordleRoom.onAuth only admits
 *    the match's two actual participants, so this is safe to expose, but it
 *    only succeeds if a seat is actually still open (e.g. the very first
 *    load in a case #1/#2 didn't apply).
 */
export default function MatchPage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [currentUserId, setCurrentUserId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function connect(): Promise<Room> {
      const client = getColyseusClient();

      const pending = takePendingMatchRoom(params.roomId);
      if (pending) return pending;

      const stored = loadActiveMatch(params.roomId);
      if (stored) {
        try {
          return await client.reconnect(stored.reconnectionToken);
        } catch {
          // Reconnection token expired or was already consumed — fall through
          // to a fresh join attempt below.
        }
      }

      const token = await getToken();
      const fresh = await client.joinById(params.roomId, { authToken: token });
      saveActiveMatch(fresh.roomId, fresh.reconnectionToken);
      return fresh;
    }

    (async () => {
      try {
        const token = await getToken();
        const [me, connectedRoom] = await Promise.all([getMe(token), connect()]);
        if (cancelled) {
          connectedRoom.leave();
          return;
        }
        // Keep the stored token current so a second refresh can still reconnect.
        saveActiveMatch(connectedRoom.roomId, connectedRoom.reconnectionToken);
        setCurrentUserId(me.id);
        setRoom(connectedRoom);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not connect to this match");
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [getToken, params.roomId]);

  function handleExit() {
    room?.leave();
    clearActiveMatch();
    router.push("/");
  }

  if (error) {
    return (
      <div className="card">
        <p className="error-text">{error}</p>
        <button className="btn-secondary" onClick={() => router.push("/")} style={{ marginTop: 12 }}>
          Back to lobby
        </button>
      </div>
    );
  }

  if (!room || !currentUserId) {
    return (
      <div className="card">
        <p className="muted">
          Connecting <span className="spinner-dot" />
        </p>
      </div>
    );
  }

  return <Match room={room} currentUserId={currentUserId} onExit={handleExit} />;
}
