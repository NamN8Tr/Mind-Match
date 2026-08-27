"use client";

import { useAuth } from "@clerk/nextjs";
import type { Room } from "@colyseus/sdk";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Match } from "../../../components/Match";
import { getMe } from "../../../lib/api";
import { getColyseusClient } from "../../../lib/colyseus";

/**
 * Direct-link / refresh-resilience entry point for a match already in
 * progress. The normal "Find Match" flow never navigates here — it renders
 * <Match> inline once matchmaking hands back an already-connected room — but
 * a page reload needs somewhere to reconnect to. WordleRoom.onAuth only
 * admits the match's two actual participants, so this is safe to expose.
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
    (async () => {
      try {
        const token = await getToken();
        const [me, connectedRoom] = await Promise.all([
          getMe(token),
          getColyseusClient().joinById(params.roomId, { authToken: token }),
        ]);
        if (cancelled) {
          connectedRoom.leave();
          return;
        }
        setCurrentUserId(me.id);
        setRoom(connectedRoom);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Could not reconnect to this match");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [getToken, params.roomId]);

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
          Reconnecting <span className="spinner-dot" />
        </p>
      </div>
    );
  }

  return <Match room={room} currentUserId={currentUserId} onExit={() => router.push("/")} />;
}
