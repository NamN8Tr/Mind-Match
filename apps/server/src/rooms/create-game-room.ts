import { Room, type Client, type Delayed } from "@colyseus/core";
import {
  GameRuleViolation,
  type GameEngine,
  type GameId,
  type MatchOpponentInfo,
  type MatchResult,
  type PlayerId,
} from "@smart-rot/shared-types";
import { resolveAuthenticatedUser } from "../auth/clerk.js";
import { prisma } from "../db/prisma.js";
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
/** Ready-up window shown after both players arrive and before moves/timer begin. */
const COUNTDOWN_MS = 3_000;
/** Grace before tearing the room down, so the concluding messages actually reach both clients. */
const DISPOSE_DELAY_MS = 5_000;

export interface GameRoomOptions {
  /** Time allowed for both reserved players to connect and signal ready. Default 30 seconds. */
  joinDeadlineMs?: number;
  /** Time allowed for a dropped client to resume before forfeiting. Default 20 seconds. */
  reconnectGraceSeconds?: number;
  /** Ready-up countdown after both players are ready. Default 3 seconds. */
  countdownMs?: number;
  /** Wall-clock cap after the countdown ends; nobody solving in time is a draw. Default 30 minutes. */
  matchTimeoutMs?: number;
  /**
   * Ranked races normally forfeit a departed player. Spider instead keeps the
   * board alive for the remaining player and only draws when both have left.
   */
  departurePolicy?: "forfeit" | "continue-until-both-leave";
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
  const joinDeadlineMs = roomOptions.joinDeadlineMs ?? JOIN_DEADLINE_MS;
  const reconnectGraceSeconds = roomOptions.reconnectGraceSeconds ?? RECONNECT_GRACE_SECONDS;
  const countdownMs = roomOptions.countdownMs ?? COUNTDOWN_MS;
  const matchTimeoutMs = roomOptions.matchTimeoutMs ?? 30 * 60_000;
  const departurePolicy = roomOptions.departurePolicy ?? "forfeit";

  return class GameRoom extends Room {
    maxClients = 2;

    private matchId!: string;
    private playerIds!: [PlayerId, PlayerId];
    private gameState!: State;
    private countdownStarted = false;
    private started = false;
    private finished = false;
    private playerIdBySessionId = new Map<string, PlayerId>();
    private playerInfo = new Map<PlayerId, MatchOpponentInfo>();
    /** Players who have connected *and* confirmed their listeners are attached (see the "ready" handler). */
    private readyPlayerIds = new Set<PlayerId>();
    private departedPlayerIds = new Set<PlayerId>();
    private joinDeadlineTimer?: Delayed;
    private countdownTimer?: Delayed;
    private matchTimeoutTimer?: Delayed;
    private countdownEndsAt?: number;
    private matchStartedAt?: number;
    private matchDeadlineAt?: number;

    async onCreate(options: GameRoomCreateOptions): Promise<void> {
      this.matchId = options.matchId;
      this.playerIds = options.playerIds;
      this.gameState = engine.generateInitialState(options.seed, options.playerIds);
      // A player mid-refresh briefly leaves the room with zero clients; don't
      // tear the match down underneath them. Every terminal path below
      // explicitly disposes instead.
      this.autoDispose = false;

      this.joinDeadlineTimer = this.clock.setTimeout(() => {
        if (!this.started) void this.concludeMatch({ status: "aborted", reason: "no-show" });
      }, joinDeadlineMs);

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

      const participants = await prisma.matchParticipant.findMany({
        where: { matchId: this.matchId },
        include: { user: { select: { displayName: true } } },
      });
      for (const participant of participants) {
        this.playerInfo.set(participant.userId, {
          userId: participant.userId,
          displayName: participant.user.displayName,
          rating: participant.ratingBefore,
        });
      }
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
      this.allowReconnection(client, reconnectGraceSeconds).catch(() => {
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

      if (departurePolicy === "continue-until-both-leave") {
        this.departedPlayerIds.add(playerId);
        this.broadcast("playerLeft", { playerId });
        if (this.departedPlayerIds.size === this.playerIds.length) {
          void this.concludeMatch({ status: "draw", reason: "both-left" });
        }
        return;
      }

      const remainingPlayerId = this.playerIds.find((id) => id !== playerId)!;
      void this.concludeMatch({ status: "win", winnerId: remainingPlayerId, reason: "opponent-left" });
    }

    private handleReady(client: Client): void {
      const playerId = this.playerIdBySessionId.get(client.sessionId);
      if (!playerId) return;

      this.readyPlayerIds.add(playerId);
      client.send("phase", this.started ? "active" : this.countdownStarted ? "countdown" : "waiting");
      this.sendOpponentTo(client, playerId);
      this.sendStateTo(client, playerId);
      if (this.started) {
        this.sendClockTo(client);
      } else if (this.countdownStarted) {
        this.sendCountdownTo(client);
      }

      if (!this.started && !this.countdownStarted && this.readyPlayerIds.size === this.playerIds.length) {
        this.startCountdown();
      }
    }

    private startCountdown(): void {
      this.countdownStarted = true;
      this.joinDeadlineTimer?.clear();
      const serverNow = Date.now();
      this.countdownEndsAt = serverNow + countdownMs;
      this.broadcast("phase", "countdown");
      this.broadcast("countdown", { endsAt: this.countdownEndsAt, serverNow });
      this.countdownTimer = this.clock.setTimeout(() => this.beginMatch(), countdownMs);
    }

    private beginMatch(): void {
      if (this.finished || this.started) return;
      const now = Date.now();
      if (this.countdownEndsAt !== undefined && now < this.countdownEndsAt) {
        this.countdownTimer = this.clock.setTimeout(() => this.beginMatch(), this.countdownEndsAt - now);
        return;
      }
      this.started = true;
      this.matchStartedAt = now;
      this.matchDeadlineAt = this.matchStartedAt + matchTimeoutMs;
      this.broadcast("phase", "active");
      this.broadcast("clock", { startedAt: this.matchStartedAt, deadlineAt: this.matchDeadlineAt, serverNow: Date.now() });
      this.matchTimeoutTimer = this.clock.setTimeout(() => {
        void this.handleMatchTimeout();
      }, matchTimeoutMs);
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
      void this.concludeMatch(engine.getTimeoutResult?.(this.gameState) ?? { status: "draw", reason: "timeout" });
    }

    private sendClockTo(client: Client): void {
      if (this.matchStartedAt !== undefined && this.matchDeadlineAt !== undefined) {
        client.send("clock", { startedAt: this.matchStartedAt, deadlineAt: this.matchDeadlineAt, serverNow: Date.now() });
      }
    }

    private sendCountdownTo(client: Client): void {
      if (this.countdownEndsAt !== undefined) {
        client.send("countdown", { endsAt: this.countdownEndsAt, serverNow: Date.now() });
      }
    }

    private sendOpponentTo(client: Client, userId: PlayerId): void {
      const opponentId = this.playerIds.find((id) => id !== userId);
      const opponent = opponentId ? this.playerInfo.get(opponentId) : undefined;
      if (opponent) client.send("opponent", opponent);
    }

    private sendStateTo(client: Client, userId: PlayerId, matchResult?: MatchResult): void {
      client.send("state", engine.serializeStateForPlayer(this.gameState, userId, matchResult));
    }

    private broadcastState(matchResult?: MatchResult): void {
      for (const client of this.clients) {
        const userId = this.playerIdBySessionId.get(client.sessionId);
        if (userId) this.sendStateTo(client, userId, matchResult);
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
      this.countdownTimer?.clear();
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

      this.broadcastState(outcome?.result ?? result);
      this.broadcast("result", {
        result: outcome?.result ?? result,
        ratings: outcome?.ratings ?? null,
        persisted: outcome !== null,
      });

      this.clock.setTimeout(() => void this.disconnect(), DISPOSE_DELAY_MS);
    }
  };
}
