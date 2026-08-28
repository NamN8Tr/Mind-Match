-- Moving the displayed starting point from 1500 to 400 is a translation of
-- the rating scale, not a competitive reset. Shift every existing rating and
-- history snapshot by the same amount so ranks and recorded deltas stay intact.
UPDATE "ratings"
SET "rating" = "rating" - 1100;

UPDATE "match_participants"
SET
  "ratingBefore" = "ratingBefore" - 1100,
  "ratingAfter" = CASE
    WHEN "ratingAfter" IS NULL THEN NULL
    ELSE "ratingAfter" - 1100
  END;
