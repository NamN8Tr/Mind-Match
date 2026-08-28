CREATE TABLE "personal_bests" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "gameId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "bestTimeMs" INTEGER NOT NULL,
    "achievedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "personal_bests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "personal_bests_userId_gameId_mode_key"
ON "personal_bests"("userId", "gameId", "mode");

CREATE INDEX "personal_bests_userId_idx" ON "personal_bests"("userId");

ALTER TABLE "personal_bests"
ADD CONSTRAINT "personal_bests_userId_fkey"
FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
