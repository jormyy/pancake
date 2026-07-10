-- Canonical SQL source for private.current_add_week_number.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.current_add_week_number(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS int
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_season_year int;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_week int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  IF v_season_year IS NULL THEN
    RETURN 1;
  END IF;

  SELECT week_number
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year
     AND week_start <= v_today
     AND week_end >= v_today
   ORDER BY week_number
   LIMIT 1;

  IF v_week IS NOT NULL THEN
    RETURN v_week;
  END IF;

  SELECT week_number
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year
     AND week_end >= v_today
   ORDER BY week_start
   LIMIT 1;

  IF v_week IS NOT NULL THEN
    RETURN v_week;
  END IF;

  SELECT max(week_number)
    INTO v_week
    FROM season_weeks
   WHERE season_year = v_season_year;

  RETURN COALESCE(v_week, 1);
END;
$$;
