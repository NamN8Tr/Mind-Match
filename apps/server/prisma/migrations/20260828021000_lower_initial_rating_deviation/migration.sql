-- The rating scale was moved from 1500 to 400, but its initial uncertainty was
-- still 350. That made early results swing by well over 100 points. There is no
-- production data yet, so reset local test pools to the calmer starting RD.
ALTER TABLE "ratings" ALTER COLUMN "deviation" SET DEFAULT 100;

UPDATE "ratings"
SET "deviation" = 100;
