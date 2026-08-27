const STORAGE_KEY = "smart-rot:active-match";

interface StoredMatch {
  roomId: string;
  reconnectionToken: string;
}

/**
 * Survives a page refresh (unlike lib/pending-match's in-memory handoff), so
 * app/match/[roomId]/page.tsx can resume a match with Colyseus's own
 * reconnection protocol (client.reconnect(token)) instead of a fresh join.
 */
export function saveActiveMatch(roomId: string, reconnectionToken: string): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ roomId, reconnectionToken } satisfies StoredMatch));
  } catch {
    // sessionStorage can throw in some private-browsing modes — losing the
    // ability to resume a refreshed match isn't worth failing the request over.
  }
}

export function loadActiveMatch(roomId: string): StoredMatch | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredMatch;
    return parsed.roomId === roomId ? parsed : null;
  } catch {
    return null;
  }
}

export function clearActiveMatch(): void {
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // see saveActiveMatch
  }
}
