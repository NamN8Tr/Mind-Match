import { randomUUID } from "node:crypto";
import { Room, type Client, type Delayed } from "@colyseus/core";
import {
  GameRuleViolation,
  type GameEngine,
  type MatchResult,
  type SoloResultMessage,
  type SpiderMove,
  type SpiderState,
} from "@smart-rot/shared-types";
import { resolveAuthenticatedUser } from "../auth/clerk.js";
import { recordTimedPersonalBest } from "../personal-best/service.js";

const COUNTDOWN_MS = 3_000;
/** A run ends only after this long with no accepted move — there is no cap on a run's length. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
const RECONNECT_GRACE_SECONDS = 20;
const DISPOSE_DELAY_MS = 5_000;

export interface SpiderSoloRoomOptions {
  countdownMs?: number;
  /** How long a run may sit with no accepted move before it is abandoned. Default 10 minutes. */
  idleTimeoutMs?: number;
  /** Test seam only. Production uses a cryptographically random seed. */
  seedFactory?: () => string;
  /** Claims and pins an ahead-of-time board before synchronous engine state creation. */
  prepareSeed?: (seed: string) => Promise<void>;
}

interface SoloAuth {
  userId: string;
}

interface SoloJoinOptions {
  authToken?: string;
}

export function createSpiderSoloRoom(
  engine: GameEngine<SpiderState, SpiderMove>,
  options: SpiderSoloRoomOptions = {},
) {
  const countdownMs = options.countdownMs ?? COUNTDOWN_MS;
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const seedFactory = options.seedFactory ?? randomUUID;
  const prepareSeed = options.prepareSeed;

  return class SpiderSoloRoom extends Room {
    maxClients = 1;

    private userId?: string;
    private gameState?: SpiderState;
    private countdownStarted = false;
    private started = false;
    private finished = false;
    private processingMove = false;
    private countdownEndsAt?: number;
    private runStartedAt?: number;
    private runDeadlineAt?: number;
    private countdownTimer?: Delayed;
    private runTimer?: Delayed;
    /** When the last accepted move landed; the idle window is measured from here. */
    private lastActivityAt?: number;

    onCreate(): void {
      this.onMessage("ready", (client) => this.handleReady(client));
      this.onMessage<SpiderMove>("move", (client, move) => void this.handleMove(client, move));
    }

    async onAuth(_client: Client, joinOptions: SoloJoinOptions): Promise<SoloAuth> {
      const user = await resolveAuthenticatedUser(joinOptions.authToken);
      return { userId: user.id };
    }

    async onJoin(_client: Client, _options: unknown, auth: SoloAuth): Promise<void> {
      this.autoDispose = false;
      this.userId = auth.userId;
      const seed = seedFactory();
      await prepareSeed?.(seed);
      this.gameState = engine.generateInitialState(seed, [auth.userId]);
    }

    onDrop(client: Client): void {
      if (!this.finished) this.allowReconnection(client, RECONNECT_GRACE_SECONDS).catch(() => undefined);
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
      if (this.started) this.sendClock(client);
      else if (this.countdownStarted) this.sendCountdown(client);
      else this.startCountdown();
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
      this.lastActivityAt = now;
      this.runDeadlineAt = now + idleTimeoutMs;
      this.broadcast("phase", "active");
      this.broadcast("clock", { startedAt: now, deadlineAt: this.runDeadlineAt, serverNow: now });
      this.armIdleTimeout(idleTimeoutMs);
    }

    private async handleMove(client: Client, move: SpiderMove): Promise<void> {
      if (!this.userId || !this.gameState || this.finished || this.processingMove) return;
      if (!this.started) {
        client.send("moveRejected", { message: "The run hasn't started yet" });
        return;
      }
      try {
        engine.validateMove(this.gameState, move, this.userId);
      } catch (error) {
        client.send("moveRejected", { message: error instanceof GameRuleViolation ? error.message : "Invalid move" });
        return;
      }

      this.processingMove = true;
      this.gameState = engine.applyMove(this.gameState, move, this.userId).state;
      this.lastActivityAt = Date.now();
      this.runDeadlineAt = this.lastActivityAt + idleTimeoutMs;
      if (engine.isTerminal(this.gameState)) {
        await this.conclude(this.gameState.players[this.userId]?.solved === true);
      } else {
        this.sendState(client);
      }
      this.processingMove = false;
    }

    private armIdleTimeout(delayMs: number): void {
      this.runTimer?.clear();
      this.runTimer = this.clock.setTimeout(() => {
        // Moves roll the window forward without touching the timer, so this may
        // fire on a window that has since moved; re-arm for whatever is left.
        const idleForMs = Date.now() - (this.lastActivityAt ?? Date.now());
        if (idleForMs < idleTimeoutMs) {
          this.armIdleTimeout(idleTimeoutMs - idleForMs);
          return;
        }
        void this.conclude(false);
      }, delayMs);
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
          const recorded = await recordTimedPersonalBest(this.userId, "spider", this.gameState.mode, elapsedMs);
          bestTimeMs = recorded.personalBest.bestTimeMs;
          isPersonalBest = recorded.improved;
        } catch (error) {
          persisted = false;
          console.error(`Failed to record Spider solo personal best for ${this.userId}:`, error);
        }
      }

      const result: MatchResult = solved
        ? { status: "win", winnerId: this.userId, reason: "solved" }
        : { status: "draw", reason: "no-solve" };
      for (const client of this.clients) this.sendState(client, result);
      this.broadcast("soloResult", { solved, elapsedMs, bestTimeMs, isPersonalBest, persisted } satisfies SoloResultMessage);
      this.clock.setTimeout(() => void this.disconnect(), DISPOSE_DELAY_MS);
    }

    private sendState(client: Client, result?: MatchResult): void {
      if (this.userId && this.gameState) {
        client.send("state", engine.serializeStateForPlayer(this.gameState, this.userId, result));
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
