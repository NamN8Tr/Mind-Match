-- Ratings are independent per game mode. Existing test data belongs to the
-- original Speed ruleset; Fewest Guesses receives a fresh rating on first use.
DROP INDEX "ratings_userId_gameId_key";
DROP INDEX "ratings_gameId_rating_idx";

ALTER TABLE "ratings" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'speed';
ALTER TABLE "ratings" ALTER COLUMN "mode" DROP DEFAULT;

CREATE UNIQUE INDEX "ratings_userId_gameId_mode_key" ON "ratings"("userId", "gameId", "mode");
CREATE INDEX "ratings_gameId_mode_rating_idx" ON "ratings"("gameId", "mode", "rating");
