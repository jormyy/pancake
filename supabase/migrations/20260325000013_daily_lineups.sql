-- Convert weekly_lineups from per-week to per-day.
-- Each day of a fantasy week now has its own lineup entry.

ALTER TABLE weekly_lineups ADD COLUMN IF NOT EXISTS game_date date;

-- Backfill existing rows (dev only — no prod data)
UPDATE weekly_lineups SET game_date = CURRENT_DATE WHERE game_date IS NULL;

ALTER TABLE weekly_lineups ALTER COLUMN game_date SET NOT NULL;

-- Drop the old week-based unique constraint (find it dynamically since PG truncates long names)
DO $$
DECLARE
    v_name text;
BEGIN
    SELECT conname INTO v_name
    FROM pg_constraint
    WHERE conrelid = 'weekly_lineups'::regclass
      AND contype = 'u'
    ORDER BY conname
    LIMIT 1;

    IF v_name IS NOT NULL THEN
        EXECUTE format('ALTER TABLE weekly_lineups DROP CONSTRAINT %I', v_name);
    END IF;
END $$;

-- Deduplicate rows that got the same game_date from the backfill
DELETE FROM weekly_lineups a
USING weekly_lineups b
WHERE a.id > b.id
  AND a.league_id = b.league_id
  AND a.league_season_id = b.league_season_id
  AND a.member_id = b.member_id
  AND a.player_id = b.player_id
  AND a.game_date = b.game_date;

-- Add new date-based unique constraint
ALTER TABLE weekly_lineups
    ADD CONSTRAINT weekly_lineups_per_day_unique
    UNIQUE (league_id, league_season_id, member_id, player_id, game_date);
