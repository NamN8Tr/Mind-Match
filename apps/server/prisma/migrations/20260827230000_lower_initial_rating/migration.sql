-- New players begin on a compact, beginner-friendly displayed rating scale.
-- Existing ratings are intentionally preserved; this only changes the default
-- for rows created after the migration.
ALTER TABLE "ratings" ALTER COLUMN "rating" SET DEFAULT 400;
