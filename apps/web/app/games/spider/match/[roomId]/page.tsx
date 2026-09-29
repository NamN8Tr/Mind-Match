"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room } from "@colyseus/sdk";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SpiderGame } from "../../../../../components/SpiderGame";
import { getMe } from "../../../../../lib/api";
import { getColyseusClient } from "../../../../../lib/colyseus";
import { clearActiveMatch, loadActiveMatch, saveActiveMatch } from "../../../../../lib/match-storage";
import { takePendingMatchRoom } from "../../../../../lib/pending-match";

interface MatchConnection {
  room: Room;
  currentUserId: string;
}

interface PendingConnection {
  roomId: string;
  promise: Promise<MatchConnection>;
}

export default function SpiderMatchPage() {
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
    if (cleanupTimerRef.current !== null) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    async function connect(authToken: string | null): Promise<Room> {
      const pending = takePendingMatchRoom(params.roomId);
      if (pending) return pending;
      const client = getColyseusClient();
      const stored = loadActiveMatch(params.roomId);
      if (stored) {
        try {
          return await client.reconnect(stored.reconnectionToken);
        } catch {
          clearActiveMatch();
        }
      }
      const fresh = await client.joinById(params.roomId, { authToken });
      saveActiveMatch(fresh.roomId, fresh.reconnectionToken);
      return fresh;
    }

    const createConnection = async (): Promise<MatchConnection> => {
      const token = await getToken();
      // allSettled, not all: a failed profile fetch must not strand a room that
      // did connect — the error screen has no room to leave, so leave it here.
      const [meResult, roomResult] = await Promise.allSettled([getMe(token), connect(token)]);
      if (meResult.status === "rejected") {
        if (roomResult.status === "fulfilled") void roomResult.value.leave().catch(() => undefined);
        throw meResult.reason;
      }
      if (roomResult.status === "rejected") throw roomResult.reason;
      return { room: roomResult.value, currentUserId: meResult.value.id };
    };

    let connection = connectionRef.current;
    if (!connection || connection.roomId !== params.roomId) {
      connection = { roomId: params.roomId, promise: createConnection() };
      connectionRef.current = connection;
    }
    void connection.promise.then(
      ({ room: connected, currentUserId: userId }) => {
        if (!active) return;
        saveActiveMatch(connected.roomId, connected.reconnectionToken);
        setRoom(connected);
        setCurrentUserId(userId);
      },
      (caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : "Could not connect to this Spider race");
      },
    );

    return () => {
      active = false;
      cleanupTimerRef.current = setTimeout(() => {
        if (connectionRef.current !== connection) return;
        connectionRef.current = null;
        void connection.promise.then(({ room: connected }) => connected.leave()).catch(() => undefined);
      }, 0);
    };
  }, [getToken, params.roomId]);

  function exit(): void {
    connectionRef.current = null;
    void room?.leave();
    clearActiveMatch();
    router.push("/games/spider");
  }

  if (error) return <div className="card"><p className="error-text">{error}</p><button className="btn-secondary" onClick={exit}>Back to Spider</button></div>;
  if (!room || !currentUserId) return <div className="card"><p className="muted">Connecting <span className="spinner-dot" /></p></div>;
  return <SpiderGame room={room} kind="ranked" currentUserId={currentUserId} onExit={exit} />;
}
