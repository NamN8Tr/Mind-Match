-- Existing Wordle matches used the original first-solve-wins rules, now named
-- "speed". The default preserves that history while new queues set mode
-- explicitly.
ALTER TABLE "matches" ADD COLUMN "mode" TEXT NOT NULL DEFAULT 'speed';
