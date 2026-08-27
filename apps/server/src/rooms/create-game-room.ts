import { Room, type Client } from "@colyseus/core";
import { GameRuleViolation, type GameEngine, type GameId, type MatchResult, type PlayerId } from "@smart-rot/shared-types";
import { verifyClerkAuthToken } from "../auth/clerk.js";
import { finalizeMatch } from "../matchmaking/match-service.js";

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
export function createGameRoom<State, Move>(engine: GameEngine<State, Move>) {
  return class GameRoom extends Room {
    maxClients = 2;

    private matchId!: string;
    private playerIds!: [PlayerId, PlayerId];
    private gameState!: State;
    private finished = false;
    private playerIdBySessionId = new Map<string, PlayerId>();

    onCreate(options: GameRoomCreateOptions): void {
      this.matchId = options.matchId;
      this.playerIds = options.playerIds;
      this.gameState = engine.generateInitialState(options.seed, options.playerIds);
      // Keeps the match alive with zero clients briefly (e.g. a client reloading
      // the page mid-join) instead of tearing down the moment the last socket drops.
      this.autoDispose = false;

      this.onMessage<Move>("move", (client, move) => {
        this.handleMove(client, move);
      });
    }

    async onAuth(client: Client, options: GameRoomJoinOptions): Promise<GameRoomAuth> {
      const userId = await verifyClerkAuthToken(options.authToken);
      if (!this.playerIds.includes(userId)) {
        throw new Error("You are not a participant in this match");
      }
      return { userId };
    }

    onJoin(client: Client, _options: unknown, auth: GameRoomAuth): void {
      this.playerIdBySessionId.set(client.sessionId, auth.userId);
      this.sendStateTo(client, auth.userId);
    }

    onLeave(client: Client): void {
      const leavingPlayerId = this.playerIdBySessionId.get(client.sessionId);
      this.playerIdBySessionId.delete(client.sessionId);
      if (this.finished || !leavingPlayerId) return;

      // Phase 1 keeps disconnect handling simple: an immediate forfeit, no
      // reconnection grace window. Revisit once flaky-connection reports show up.
      const remainingPlayerId = this.playerIds.find((id) => id !== leavingPlayerId)!;
      void this.finishMatch({
        status: "win",
        winnerId: remainingPlayerId,
        reason: "opponent-left",
      });
    }

    private handleMove(client: Client, move: Move): void {
      const userId = this.playerIdBySessionId.get(client.sessionId);
      if (!userId || this.finished) return;

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
        void this.finishMatch(engine.getResult(this.gameState));
      }
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

    private async finishMatch(result: MatchResult): Promise<void> {
      if (this.finished) return;
      this.finished = true;

      this.broadcastState();
      for (const client of this.clients) {
        client.send("result", result);
      }

      try {
        await finalizeMatch(this.matchId, engine.gameId as GameId, this.playerIds, result, this.gameState);
      } catch (error) {
        // Phase 1 has no retry/alerting pipeline for a persistence failure here;
        // logging keeps the room from crashing while that gap gets addressed.
        console.error(`Failed to finalize match ${this.matchId}:`, error);
      }

      this.clock.setTimeout(() => void this.disconnect(), 5000);
    }
  };
}
