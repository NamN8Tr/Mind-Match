import type { Room } from "@colyseus/sdk";

/**
 * Hands an already-connected match Room across the client-side navigation
 * from "/" (where matchmaking resolves) to "/match/[roomId]" (the canonical
 * match URL), so the freshly consumed seat reservation's live connection
 * isn't thrown away just to immediately reconnect. Module-scoped state is
 * enough here — Next's client-side router keeps this module instance alive
 * across the navigation; a hard refresh clears it, which is fine, since
 * app/match/[roomId]/page.tsx falls back to a real reconnect in that case.
 */
let pending: { roomId: string; room: Room } | null = null;

export function setPendingMatchRoom(room: Room): void {
  pending = { roomId: room.roomId, room };
}

export function takePendingMatchRoom(roomId: string): Room | null {
  if (pending && pending.roomId === roomId) {
    const room = pending.room;
    pending = null;
    return room;
  }
  return null;
}
