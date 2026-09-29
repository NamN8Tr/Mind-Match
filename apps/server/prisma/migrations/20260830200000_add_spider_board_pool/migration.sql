CREATE TABLE "spider_boards" (
    "id" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "deal" JSONB NOT NULL,
    "solverSeed" TEXT NOT NULL,
    "solverStates" INTEGER NOT NULL,
    "solverTimeMs" INTEGER NOT NULL,
    "solutionMoves" INTEGER NOT NULL,
    "difficultyScore" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spider_boards_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "spider_boards_mode_createdAt_idx" ON "spider_boards"("mode", "createdAt");
