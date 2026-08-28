"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room } from "@colyseus/sdk";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Match } from "../../../components/Match";
import { getMe } from "../../../lib/api";
import { getColyseusClient } from "../../../lib/colyseus";
import { clearActiveMatch, loadActiveMatch, saveActiveMatch } from "../../../lib/match-storage";
import { takePendingMatchRoom } from "../../../lib/pending-match";

interface MatchConnection {
  room: Room;
  currentUserId: string;
}

interface PendingConnection {
  roomId: string;
  promise: Promise<MatchConnection>;
}

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
  const connectionRef = useRef<PendingConnection | null>(null);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;

    // In development, React Strict Mode immediately runs an effect's cleanup
    // and setup again. Cancel a deferred real-unmount cleanup so both setups
    // share one Colyseus connection instead of racing for the same reconnect
    // token (and having the discarded setup consent to a match forfeit).
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    async function connect(authToken: string | null): Promise<Room> {
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
          clearActiveMatch();
        }
      }

      const fresh = await client.joinById(params.roomId, { authToken });
      saveActiveMatch(fresh.roomId, fresh.reconnectionToken);
      return fresh;
    }

    function createConnection(): Promise<MatchConnection> {
      return (async () => {
        const token = await getToken();
        const [meResult, roomResult] = await Promise.allSettled([getMe(token), connect(token)]);
        if (meResult.status === "rejected") {
          if (roomResult.status === "fulfilled") void roomResult.value.leave().catch(() => undefined);
          throw meResult.reason;
        }
        if (roomResult.status === "rejected") throw roomResult.reason;
        return { room: roomResult.value, currentUserId: meResult.value.id };
      })();
    }

    const previousConnection = connectionRef.current;
    let connection = previousConnection;
    if (!connection || connection.roomId !== params.roomId) {
      if (previousConnection) {
        void previousConnection.promise.then(({ room: previousRoom }) => previousRoom.leave()).catch(() => undefined);
      }
      connection = { roomId: params.roomId, promise: createConnection() };
      connectionRef.current = connection;
    }

    void connection.promise.then(
      ({ room: connectedRoom, currentUserId: connectedUserId }) => {
        if (!active) return;
        // Keep the stored token current so a second refresh can still reconnect.
        saveActiveMatch(connectedRoom.roomId, connectedRoom.reconnectionToken);
        setCurrentUserId(connectedUserId);
        setRoom(connectedRoom);
      },
      (err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not connect to this match");
      },
    );

    return () => {
      active = false;
      cleanupTimerRef.current = setTimeout(() => {
        // A real client-side navigation gets no replacement setup to cancel
        // this timer, so it remains a deliberate leave. A document refresh
        // drops the socket naturally and is handled by server reconnection.
        if (connectionRef.current !== connection) return;
        connectionRef.current = null;
        void connection.promise.then(({ room: connectedRoom }) => connectedRoom.leave()).catch(() => undefined);
      }, 0);
    };
  }, [getToken, params.roomId]);

  function handleExit() {
    connectionRef.current = null;
    void room?.leave();
    clearActiveMatch();
    router.push("/games/wordle");
  }

  if (error) {
    return (
      <div className="card">
        <p className="error-text">{error}</p>
        <button className="btn-secondary" onClick={() => router.push("/games/wordle")} style={{ marginTop: 12 }}>
          Back to Wordle
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
