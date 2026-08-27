import type { Glicko2Rating } from "@smart-rot/shared-types";

const API_URL = process.env["NEXT_PUBLIC_API_URL"] ?? "http://localhost:4000";

export interface MeResponse {
  id: string;
  displayName: string;
  ratings: Glicko2Rating[];
}

export interface MatchHistoryPlayer {
  userId: string;
  displayName: string;
  isWinner: boolean;
}

export interface MatchHistoryEntry {
  matchId: string;
  gameId: string;
  status: "ACTIVE" | "COMPLETED" | "ABORTED";
  resultStatus: string | null;
  resultReason: string | null;
  createdAt: string;
  completedAt: string | null;
  ratingBefore: number;
  ratingAfter: number | null;
  players: MatchHistoryPlayer[];
}

async function apiFetch<T>(path: string, token: string | null): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!response.ok) {
    throw new Error(`Request to ${path} failed with ${response.status}`);
  }
  return (await response.json()) as T;
}

export function getMe(token: string | null): Promise<MeResponse> {
  return apiFetch<MeResponse>("/api/me", token);
}

export function getMatchHistory(token: string | null, gameId = "wordle"): Promise<MatchHistoryEntry[]> {
  return apiFetch<MatchHistoryEntry[]>(`/api/matches?gameId=${encodeURIComponent(gameId)}`, token);
}
