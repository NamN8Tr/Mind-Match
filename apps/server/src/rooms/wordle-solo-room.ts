import { randomUUID } from "node:crypto";
import { Room, type Client, type Delayed } from "@colyseus/core";
import { wordleSpeedEngine } from "@smart-rot/game-engines";
import { GameRuleViolation, type MatchResult, type SoloResultMessage, type WordleMove, type WordleState } from "@smart-rot/shared-types";
import { resolveAuthenticatedUser } from "../auth/clerk.js";
import { recordTimedPersonalBest } from "../personal-best/service.js";

const COUNTDOWN_MS = 3_000;
const RUN_TIMEOUT_MS = 5 * 60_000;
const RECONNECT_GRACE_SECONDS = 20;
const DISPOSE_DELAY_MS = 5_000;

export interface WordleSoloRoomOptions {
  countdownMs?: number;
  runTimeoutMs?: number;
  /** Test seam only. Production uses a cryptographically random seed. */
  seedFactory?: () => string;
}

interface SoloAuth {
  userId: string;
}

interface SoloJoinOptions {
  authToken?: string;
}

export function createWordleSoloRoom(options: WordleSoloRoomOptions = {}) {
  const countdownMs = options.countdownMs ?? COUNTDOWN_MS;
  const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
  const seedFactory = options.seedFactory ?? randomUUID;

  return class WordleSoloRoom extends Room {
    maxClients = 1;

    private userId?: string;
    private gameState?: WordleState;
    private countdownStarted = false;
    private started = false;
    private finished = false;
    private processingMove = false;
    private countdownEndsAt?: number;
    private runStartedAt?: number;
    private runDeadlineAt?: number;
    private countdownTimer?: Delayed;
    private runTimer?: Delayed;

    onCreate(): void {
      this.autoDispose = false;
      this.onMessage("ready", (client) => this.handleReady(client));
      this.onMessage<WordleMove>("move", (client, move) => {
        void this.handleMove(client, move);
      });
    }

    async onAuth(_client: Client, joinOptions: SoloJoinOptions): Promise<SoloAuth> {
      const user = await resolveAuthenticatedUser(joinOptions.authToken);
      return { userId: user.id };
    }

    onJoin(_client: Client, _options: unknown, auth: SoloAuth): void {
      this.userId = auth.userId;
      this.gameState = wordleSpeedEngine.generateInitialState(seedFactory(), [auth.userId]);
    }

    onDrop(client: Client): void {
      if (this.finished) return;
      this.allowReconnection(client, RECONNECT_GRACE_SECONDS).catch(() => undefined);
    }

    onReconnect(): void {
      // The resumed client repeats the ready handshake after installing listeners.
    }

    onLeave(): void {
      if (this.finished) return;
      this.finished = true;
      this.countdownTimer?.clear();
      this.runTimer?.clear();
      this.clock.setTimeout(() => void this.disconnect(), 0);
    }

    private handleReady(client: Client): void {
      if (!this.userId || !this.gameState || this.finished) return;
      client.send("phase", this.started ? "active" : this.countdownStarted ? "countdown" : "waiting");
      this.sendState(client);

      if (this.started) {
        this.sendClock(client);
      } else if (this.countdownStarted) {
        this.sendCountdown(client);
      } else {
        this.startCountdown();
      }
    }

    private startCountdown(): void {
      this.countdownStarted = true;
      const serverNow = Date.now();
      this.countdownEndsAt = serverNow + countdownMs;
      this.broadcast("phase", "countdown");
      this.broadcast("countdown", { endsAt: this.countdownEndsAt, serverNow });
      this.countdownTimer = this.clock.setTimeout(() => this.beginRun(), countdownMs);
    }

    private beginRun(): void {
      if (this.finished || this.started) return;
      const now = Date.now();
      if (this.countdownEndsAt !== undefined && now < this.countdownEndsAt) {
        this.countdownTimer = this.clock.setTimeout(() => this.beginRun(), this.countdownEndsAt - now);
        return;
      }
      this.started = true;
      this.runStartedAt = now;
      this.runDeadlineAt = now + runTimeoutMs;
      this.broadcast("phase", "active");
      this.broadcast("clock", { startedAt: now, deadlineAt: this.runDeadlineAt, serverNow: now });
      this.runTimer = this.clock.setTimeout(() => void this.conclude(false), runTimeoutMs);
    }

    private async handleMove(client: Client, move: WordleMove): Promise<void> {
      if (!this.userId || !this.gameState || this.finished || this.processingMove) return;
      if (!this.started) {
        client.send("moveRejected", { message: "The run hasn't started yet" });
        return;
      }

      try {
        wordleSpeedEngine.validateMove(this.gameState, move, this.userId);
      } catch (error) {
        client.send("moveRejected", { message: error instanceof GameRuleViolation ? error.message : "Invalid move" });
        return;
      }

      this.processingMove = true;
      this.gameState = wordleSpeedEngine.applyMove(this.gameState, move, this.userId).state;
      if (wordleSpeedEngine.isTerminal(this.gameState)) {
        await this.conclude(this.gameState.players[this.userId]?.solved === true);
      } else {
        this.sendState(client);
      }
      this.processingMove = false;
    }

    private async conclude(solved: boolean): Promise<void> {
      if (this.finished || !this.userId || !this.gameState) return;
      this.finished = true;
      this.countdownTimer?.clear();
      this.runTimer?.clear();

      const elapsedMs = solved && this.runStartedAt !== undefined ? Math.max(1, Date.now() - this.runStartedAt) : null;
      let bestTimeMs: number | null = null;
      let isPersonalBest = false;
      let persisted = true;

      if (elapsedMs !== null) {
        try {
          const recorded = await recordTimedPersonalBest(this.userId, "wordle", "speed", elapsedMs);
          bestTimeMs = recorded.personalBest.bestTimeMs;
          isPersonalBest = recorded.improved;
        } catch (error) {
          persisted = false;
          console.error(`Failed to record solo personal best for ${this.userId}:`, error);
        }
      }

      const result: MatchResult = solved
        ? { status: "win", winnerId: this.userId, reason: "solved" }
        : { status: "draw", reason: "no-solve" };
      for (const client of this.clients) this.sendState(client, result);
      this.broadcast("soloResult", {
        solved,
        elapsedMs,
        bestTimeMs,
        isPersonalBest,
        persisted,
      } satisfies SoloResultMessage);
      this.clock.setTimeout(() => void this.disconnect(), DISPOSE_DELAY_MS);
    }

    private sendState(client: Client, result?: MatchResult): void {
      if (this.userId && this.gameState) {
        client.send("state", wordleSpeedEngine.serializeStateForPlayer(this.gameState, this.userId, result));
      }
    }

    private sendCountdown(client: Client): void {
      if (this.countdownEndsAt !== undefined) {
        client.send("countdown", { endsAt: this.countdownEndsAt, serverNow: Date.now() });
      }
    }

    private sendClock(client: Client): void {
      if (this.runStartedAt !== undefined && this.runDeadlineAt !== undefined) {
        client.send("clock", { startedAt: this.runStartedAt, deadlineAt: this.runDeadlineAt, serverNow: Date.now() });
      }
    }
  };
}
