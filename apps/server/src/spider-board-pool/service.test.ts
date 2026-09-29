import "dotenv/config";
import assert from "node:assert/strict";
import { after, test } from "node:test";
import {
  generateVerifiedSpiderDeal,
  getBundledVerifiedSpiderDeals,
} from "@smart-rot/game-engines";
import { prisma } from "../db/prisma.js";
import { Prisma } from "../generated/prisma/client.js";
import { redis } from "../redis.js";
import { SPIDER_POOL_TARGETS, SpiderBoardPool } from "./service.js";

const TEST_SOLVER_SEED = "pool-test-seed";

after(async () => {
  await prisma.spiderBoard.deleteMany({ where: { solverSeed: TEST_SOLVER_SEED } });
  await Promise.all([prisma.$disconnect(), redis.quit()]);
});

test("harder Spider modes retain larger persistent buffers", () => {
  assert.deepEqual(SPIDER_POOL_TARGETS, {
    "1-suit": 10,
    "2-suit": 10,
    "3-suit": 20,
    "4-suit": 30,
  });
});

test("a room claims a persisted verified board immediately and pins it to its seed", async () => {
  const deal = getBundledVerifiedSpiderDeals("3-suit")[0]!;
  const stored = await prisma.spiderBoard.create({
    data: {
      mode: "3-suit",
      deal: deal as unknown as Prisma.InputJsonValue,
      solverSeed: TEST_SOLVER_SEED,
      solverStates: 300_000,
      solverTimeMs: 2_000,
      solutionMoves: deal.solution.length,
      difficultyScore: 500_000,
      createdAt: new Date(0),
    },
  });

  const pool = new SpiderBoardPool("/unused-in-claim-test");
  assert.equal(await pool.prepareSeed("persisted-pool-room", "3-suit"), true);
  assert.equal(await prisma.spiderBoard.findUnique({ where: { id: stored.id } }), null);
  assert.deepEqual(generateVerifiedSpiderDeal("persisted-pool-room", "3-suit"), deal);
});
