import { Room, type Client, type Delayed } from "@colyseus/core";
import { GameRuleViolation, type GameEngine, type GameId, type MatchResult, type PlayerId } from "@smart-rot/shared-types";
import { resolveAuthenticatedUser } from "../auth/clerk.js";
import { finalizeMatch, type FinalizeMatchOutcome } from "../matchmaking/match-service.js";

interface GameRoomCreateOptions {
  matchId: string;
  seed: string;
  playerIds: [PlayerId, PlayerId];
}

interface GameRoomJoinOptions {
  authToken?: string;
}

interface GameRoomAuth {
  userId: PlayerId;
}

/** How long a match waits for both players to connect and signal ready before aborting as a no-show. */
const JOIN_DEADLINE_MS = 30_000;
/** How long a dropped connection has to reconnect before it's ruled a forfeit. */
const RECONNECT_GRACE_SECONDS = 20;
/** Grace before tearing the room down, so the concluding messages actually reach both clients. */
const DISPOSE_DELAY_MS = 5_000;

export interface GameRoomOptions {
  /** Wall-clock cap on a match once both players are ready; nobody solving in time is a draw. Default 5 minutes. */
  matchTimeoutMs?: number;
}

/**
 * Builds a Colyseus Room class for any GameEngine plugin. This is the one place
 * matchmaking/orchestration touches game state, and it only ever goes through
 * the GameEngine contract — it never knows Wordle/Sudoku/Minesweeper rules.
 *
 * State sync is per-player message passing (`client.send("state", view)`)
 * rather than Colyseus's automatic schema sync, because GameEngine.
 * serializeStateForPlayer intentionally returns a *different* view per player
 * (e.g. hiding an opponent's guessed words) — schema sync broadcasts one shared
 * state to everyone, which doesn't fit.
 */
export function createGameRoom<State, Move>(engine: GameEngine<State, Move>, roomOptions: GameRoomOptions = {}) {
  const matchTimeoutMs = roomOptions.matchTimeoutMs ?? 5 * 60_000;

  return class GameRoom extends Room {
    maxClients = 2;

    private matchId!: string;
    private playerIds!: [PlayerId, PlayerId];
    private gameState!: State;
    private started = false;
    private finished = false;
    private playerIdBySessionId = new Map<string, PlayerId>();
    /** Players who have connected *and* confirmed their listeners are attached (see the "ready" handler). */
    private readyPlayerIds = new Set<PlayerId>();
    private joinDeadlineTimer?: Delayed;
    private matchTimeoutTimer?: Delayed;

    onCreate(options: GameRoomCreateOptions): void {
      this.matchId = options.matchId;
      this.playerIds = options.playerIds;
      this.gameState = engine.generateInitialState(options.seed, options.playerIds);
      // A player mid-refresh briefly leaves the room with zero clients; don't
      // tear the match down underneath them. Every terminal path below
      // explicitly disposes instead.
      this.autoDispose = false;

      this.joinDeadlineTimer = this.clock.setTimeout(() => {
        if (!this.started) void this.concludeMatch({ status: "aborted", reason: "no-show" });
      }, JOIN_DEADLINE_MS);

      // A client announces itself with "ready" once its message listeners are
      // attached, and that — not the socket connecting — is what starts the
      // match. Pushing the opening snapshot from onJoin instead would race the
      // client's own setup: Colyseus flushes a message sent during onJoin as
      // soon as the socket is up, which can land before the client has
      // subscribed, silently dropping the only copy of the initial state.
      this.onMessage("ready", (client) => {
        this.handleReady(client);
      });

      this.onMessage<Move>("move", (client, move) => {
        this.handleMove(client, move);
      });
    }

    async onAuth(client: Client, options: GameRoomJoinOptions): Promise<GameRoomAuth> {
      const user = await resolveAuthenticatedUser(options.authToken);
      if (!this.playerIds.includes(user.id)) {
        throw new Error("You are not a participant in this match");
      }
      // Colyseus skips onAuth entirely when resuming via a reconnection token,
      // so this rejects only a genuine second concurrent connection (a user
      // opening the match in two tabs), never a legitimate reconnect.
      if ([...this.playerIdBySessionId.values()].includes(user.id)) {
        throw new Error("You are already connected to this match from another session");
      }
      return { userId: user.id };
    }

    onJoin(client: Client, _options: unknown, auth: GameRoomAuth): void {
      // Deliberately sends nothing — the client drives the opening exchange
      // with "ready" once it can actually receive the reply.
      this.playerIdBySessionId.set(client.sessionId, auth.userId);
    }

    onDrop(client: Client): void {
      if (this.finished) return;
      // Hold the seat open. A successful reconnect resumes via onReconnect; if
      // the window expires, Colyseus then calls onLeave, which forfeits.
      this.allowReconnection(client, RECONNECT_GRACE_SECONDS).catch(() => {
        // Expected on timeout — onLeave does the real work.
      });
    }

    onReconnect(): void {
      // Same handshake as a first connection: the resumed client sends "ready"
      // once its listeners are re-attached, and gets a fresh snapshot then.
    }

    onLeave(client: Client): void {
      const playerId = this.playerIdBySessionId.get(client.sessionId);
      this.playerIdBySessionId.delete(client.sessionId);
      if (playerId) this.readyPlayerIds.delete(playerId);
      if (!playerId || this.finished) return;

      if (!this.started) {
        void this.concludeMatch({ status: "aborted", reason: "no-show" });
        return;
      }

      const remainingPlayerId = this.playerIds.find((id) => id !== playerId)!;
      void this.concludeMatch({ status: "win", winnerId: remainingPlayerId, reason: "opponent-left" });
    }

    private handleReady(client: Client): void {
      const playerId = this.playerIdBySessionId.get(client.sessionId);
      if (!playerId) return;

      this.readyPlayerIds.add(playerId);
      client.send("phase", this.started ? "active" : "waiting");
      this.sendStateTo(client, playerId);

      if (!this.started && this.readyPlayerIds.size === this.playerIds.length) {
        this.started = true;
        this.joinDeadlineTimer?.clear();
        this.broadcast("phase", "active");
        this.matchTimeoutTimer = this.clock.setTimeout(() => {
          void this.handleMatchTimeout();
        }, matchTimeoutMs);
      }
    }

    private handleMove(client: Client, move: Move): void {
      const userId = this.playerIdBySessionId.get(client.sessionId);
      if (!userId || this.finished) return;
      if (!this.started) {
        client.send("moveRejected", { message: "The match hasn't started yet" });
        return;
      }

      try {
        engine.validateMove(this.gameState, move, userId);
      } catch (error) {
        client.send("moveRejected", {
          message: error instanceof GameRuleViolation ? error.message : "Invalid move",
        });
        return;
      }

      this.gameState = engine.applyMove(this.gameState, move, userId).state;
      this.broadcastState();

      if (engine.isTerminal(this.gameState)) {
        void this.concludeMatch(engine.getResult(this.gameState));
      }
    }

    private handleMatchTimeout(): void {
      if (this.finished || engine.isTerminal(this.gameState)) return;
      void this.concludeMatch({ status: "draw", reason: "timeout" });
    }

    private sendStateTo(client: Client, userId: PlayerId): void {
      client.send("state", engine.serializeStateForPlayer(this.gameState, userId));
    }

    private broadcastState(): void {
      for (const client of this.clients) {
        const userId = this.playerIdBySessionId.get(client.sessionId);
        if (userId) this.sendStateTo(client, userId);
      }
    }

    /**
     * The single terminal path for every way a match can end — solved, timed
     * out, forfeited, or aborted before it began. Persists first, then tells
     * the clients, so nobody is shown an outcome the server failed to record.
     */
    private async concludeMatch(result: MatchResult): Promise<void> {
      if (this.finished) return;
      this.finished = true;
      this.joinDeadlineTimer?.clear();
      this.matchTimeoutTimer?.clear();

      let outcome: FinalizeMatchOutcome | null = null;
      try {
        outcome = await finalizeMatch(this.matchId, engine.gameId as GameId, this.playerIds, result, this.gameState);
      } catch (error) {
        // The match is over either way, but the rating/history write didn't
        // land. Say so rather than showing a rating change that isn't real —
        // abortStaleActiveMatches() will reap the still-ACTIVE row at next boot.
        console.error(`Failed to finalize match ${this.matchId}:`, error);
      }

      this.broadcastState();
      this.broadcast("result", {
        result: outcome?.result ?? result,
        ratings: outcome?.ratings ?? null,
        persisted: outcome !== null,
      });

      this.clock.setTimeout(() => void this.disconnect(), DISPOSE_DELAY_MS);
    }
  };
}
