"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room } from "@colyseus/sdk";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { SoloMatch } from "../../../../components/SoloMatch";
import { getColyseusClient } from "../../../../lib/colyseus";
import { clearActiveMatch, loadActiveMatch, saveActiveMatch } from "../../../../lib/match-storage";
import { takePendingMatchRoom } from "../../../../lib/pending-match";

interface PendingConnection {
  roomId: string;
  promise: Promise<Room>;
}

export default function SoloWordlePage() {
  const params = useParams<{ roomId: string }>();
  const router = useRouter();
  const { getToken } = useAuth();
  const [room, setRoom] = useState<Room | null>(null);
  const [error, setError] = useState<string | null>(null);
  const connectionRef = useRef<PendingConnection | null>(null);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let active = true;
    if (cleanupTimerRef.current) {
      clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }

    const connect = async (): Promise<Room> => {
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
      return client.joinById(params.roomId, { authToken: await getToken() });
    };

    let connection = connectionRef.current;
    if (!connection || connection.roomId !== params.roomId) {
      connection = { roomId: params.roomId, promise: connect() };
      connectionRef.current = connection;
    }
    void connection.promise.then(
      (connected) => {
        if (!active) return;
        saveActiveMatch(connected.roomId, connected.reconnectionToken);
        setRoom(connected);
      },
      (err: unknown) => {
        if (active) setError(err instanceof Error ? err.message : "Could not connect to the solo run");
      },
    );

    return () => {
      active = false;
      cleanupTimerRef.current = setTimeout(() => {
        if (connectionRef.current !== connection) return;
        connectionRef.current = null;
        void connection.promise.then((connected) => connected.leave()).catch(() => undefined);
      }, 0);
    };
  }, [getToken, params.roomId]);

  const exit = () => {
    connectionRef.current = null;
    void room?.leave();
    clearActiveMatch();
    router.push("/games/wordle");
  };

  if (error) {
    return <div className="card"><p className="error-text">{error}</p><button className="btn-secondary" onClick={exit}>Back to Wordle</button></div>;
  }
  if (!room) return <div className="card"><p className="muted">Connecting <span className="spinner-dot" /></p></div>;
  return <SoloMatch room={room} onExit={exit} />;
}
