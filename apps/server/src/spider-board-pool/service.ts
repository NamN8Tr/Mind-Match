import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  registerSpiderDealAssignment,
  verifySpiderDeal,
  type SpiderVerifiedDeal,
} from "@smart-rot/game-engines";
import { SPIDER_MODES, type SpiderMode } from "@smart-rot/shared-types";
import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { redis } from "../redis.js";

const execFileAsync = promisify(execFile);
const DEFAULT_SOLVER_PATH = fileURLToPath(
  new URL("../../../../tools/spider-solver/bin/spider-solver", import.meta.url),
);
const REFILL_LOCK_MS = 10 * 60_000;
const IDLE_POLL_MS = 5_000;

export const SPIDER_POOL_TARGETS: Record<SpiderMode, number> = {
  "1-suit": 10,
  "2-suit": 10,
  "3-suit": 20,
  "4-suit": 30,
};

interface SolverBudget {
  timeoutMs: number;
  maxStates: number;
  maxFrontier: number;
  minimumStates: number;
  minimumMoves: number;
}

const SOLVER_BUDGETS: Record<SpiderMode, SolverBudget> = {
  "1-suit": { timeoutMs: 15_000, maxStates: 1_000_000, maxFrontier: 80_000, minimumStates: 5_000, minimumMoves: 105 },
  "2-suit": { timeoutMs: 45_000, maxStates: 4_000_000, maxFrontier: 120_000, minimumStates: 100_000, minimumMoves: 130 },
  "3-suit": { timeoutMs: 120_000, maxStates: 8_000_000, maxFrontier: 160_000, minimumStates: 175_000, minimumMoves: 145 },
  "4-suit": { timeoutMs: 180_000, maxStates: 12_000_000, maxFrontier: 200_000, minimumStates: 250_000, minimumMoves: 155 },
};

interface SolverOutput {
  status: "solved" | "timeout" | "state-limit" | "exhausted";
  mode: SpiderMode;
  seed: string;
  elapsedMs: number;
  statesSearched: number;
  uniqueStates: number;
  deal?: SpiderVerifiedDeal;
}

function modeNumber(mode: SpiderMode): string {
  return mode.slice(0, 1);
}

function solverSeed(): string {
  return randomBytes(8).readBigUInt64BE().toString();
}

function isSolverOutput(value: unknown): value is SolverOutput {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<SolverOutput>;
  return typeof candidate.status === "string" &&
    typeof candidate.mode === "string" &&
    typeof candidate.seed === "string" &&
    typeof candidate.elapsedMs === "number" &&
    typeof candidate.statesSearched === "number";
}

async function releaseLock(key: string, token: string): Promise<void> {
  await redis.eval(
    "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
    1,
    key,
    token,
  );
}

export class SpiderBoardPool {
  private running = false;
  private wakeResolver?: () => void;
  private loopPromise?: Promise<void>;
  private readonly solverPath: string;
  private nextModeIndex = 0;

  constructor(solverPath = process.env["SPIDER_SOLVER_PATH"] ?? DEFAULT_SOLVER_PATH) {
    this.solverPath = solverPath;
  }

  async start(): Promise<void> {
    if (this.running) return;
    await access(this.solverPath);
    this.running = true;
    this.loopPromise = this.refillLoop();
  }

  async stop(): Promise<void> {
    this.running = false;
    this.wake();
    await this.loopPromise;
  }

  /** Claims a persisted board without making room creation wait for solving. */
  async prepareSeed(seed: string, mode: SpiderMode): Promise<boolean> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const claimed = await prisma.$transaction(async (tx) => {
          const board = await tx.spiderBoard.findFirst({ where: { mode }, orderBy: { createdAt: "asc" } });
          if (!board) return null;
          await tx.spiderBoard.delete({ where: { id: board.id } });
          return board;
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        if (!claimed) {
          this.wake();
          return false;
        }
        const deal = claimed.deal as unknown as SpiderVerifiedDeal;
        if (!verifySpiderDeal(deal, mode)) continue;
        registerSpiderDealAssignment(seed, mode, deal);
        this.wake();
        return true;
      } catch (error) {
        if (attempt === 2) throw error;
      }
    }
    return false;
  }

  async counts(): Promise<Record<SpiderMode, number>> {
    const grouped = await prisma.spiderBoard.groupBy({ by: ["mode"], _count: { _all: true } });
    const counts = Object.fromEntries(SPIDER_MODES.map((mode) => [mode, 0])) as Record<SpiderMode, number>;
    for (const row of grouped) {
      if ((SPIDER_MODES as readonly string[]).includes(row.mode)) counts[row.mode as SpiderMode] = row._count._all;
    }
    return counts;
  }

  private wake(): void {
    this.wakeResolver?.();
    this.wakeResolver = undefined;
  }

  private async waitForWake(): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, IDLE_POLL_MS);
      timer.unref();
      this.wakeResolver = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }

  private async refillLoop(): Promise<void> {
    while (this.running) {
      try {
        const counts = await this.counts();
        let mode: SpiderMode | undefined;
        for (let offset = 0; offset < SPIDER_MODES.length; offset += 1) {
          const index = (this.nextModeIndex + offset) % SPIDER_MODES.length;
          const candidate = SPIDER_MODES[index]!;
          if (counts[candidate] < SPIDER_POOL_TARGETS[candidate]) {
            mode = candidate;
            this.nextModeIndex = (index + 1) % SPIDER_MODES.length;
            break;
          }
        }
        if (!mode) {
          await this.waitForWake();
          continue;
        }
        await this.refillOne(mode);
      } catch (error) {
        console.error("Spider board refill failed:", error);
        await this.waitForWake();
      }
    }
  }

  /** Runs one bounded random-deal attempt; exposed for operations and contract tests. */
  async refillOne(mode: SpiderMode): Promise<boolean> {
    const lockKey = `spider-board-refill:${mode}`;
    const lockToken = randomUUID();
    const acquired = await redis.set(lockKey, lockToken, "PX", REFILL_LOCK_MS, "NX");
    if (acquired !== "OK") {
      await this.waitForWake();
      return false;
    }
    try {
      const count = await prisma.spiderBoard.count({ where: { mode } });
      if (count >= SPIDER_POOL_TARGETS[mode]) return false;
      const budget = SOLVER_BUDGETS[mode];
      const seed = solverSeed();
      const { stdout } = await execFileAsync(this.solverPath, [
        "--mode", modeNumber(mode),
        "--seed", seed,
        "--timeout-ms", String(budget.timeoutMs),
        "--max-states", String(budget.maxStates),
        "--max-frontier", String(budget.maxFrontier),
      ], {
        timeout: budget.timeoutMs + 10_000,
        maxBuffer: 2 * 1024 * 1024,
      });
      const parsed: unknown = JSON.parse(stdout);
      if (!isSolverOutput(parsed) || parsed.status !== "solved" || !parsed.deal) return false;
      if (
        parsed.statesSearched < budget.minimumStates ||
        parsed.deal.solution.length < budget.minimumMoves ||
        !verifySpiderDeal(parsed.deal, mode)
      ) return false;

      const difficultyScore = Math.min(
        2_147_483_647,
        parsed.statesSearched + parsed.deal.solution.length * 1_000,
      );
      await prisma.spiderBoard.create({
        data: {
          mode,
          deal: parsed.deal as unknown as Prisma.InputJsonValue,
          solverSeed: parsed.seed,
          solverStates: parsed.statesSearched,
          solverTimeMs: parsed.elapsedMs,
          solutionMoves: parsed.deal.solution.length,
          difficultyScore,
        },
      });
      return true;
    } finally {
      await releaseLock(lockKey, lockToken);
    }
  }
}

export const spiderBoardPool = new SpiderBoardPool();
