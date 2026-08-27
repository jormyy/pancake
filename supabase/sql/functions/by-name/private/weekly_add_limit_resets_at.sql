-- Canonical SQL source for private.weekly_add_limit_resets_at.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.weekly_add_limit_resets_at(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS timestamptz
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_season_year int;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_week_end date;
  v_last_end date;
  v_elapsed_weeks int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  IF v_season_year IS NULL THEN
    RETURN NULL;
  END IF;

  -- Mirrors private.current_add_week_number: inside a scheduled week, or
  -- before the next scheduled week starts, the count belongs to that week and
  -- resets at midnight ET the day after it ends.
  SELECT week_end
    INTO v_week_end
    FROM season_weeks
   WHERE season_year = v_season_year
     AND week_start <= v_today
     AND week_end >= v_today
   ORDER BY week_number
   LIMIT 1;

  IF v_week_end IS NULL THEN
    SELECT week_end
      INTO v_week_end
      FROM season_weeks
     WHERE season_year = v_season_year
       AND week_end >= v_today
     ORDER BY week_start
     LIMIT 1;
  END IF;

  IF v_week_end IS NOT NULL THEN
    RETURN (v_week_end + 1)::timestamp AT TIME ZONE 'America/New_York';
  END IF;

  SELECT max(week_end)
    INTO v_last_end
    FROM season_weeks
   WHERE season_year = v_season_year;

  IF v_last_end IS NULL THEN
    SELECT max(weeks.week_end)
      INTO v_last_end
      FROM season_weeks AS weeks
     WHERE weeks.season_year = (
       SELECT max(prior.season_year)
         FROM league_seasons AS prior
        WHERE prior.league_id = p_league_id
          AND prior.season_year < v_season_year
     );
  END IF;

  IF v_last_end IS NULL OR v_today <= v_last_end THEN
    RETURN NULL;
  END IF;

  -- Past the schedule the count rolls every 7 days from the day after the
  -- last scheduled week, in-season and offseason alike.
  v_elapsed_weeks := (v_today - v_last_end - 1) / 7;
  RETURN (v_last_end + 1 + (v_elapsed_weeks + 1) * 7)::timestamp AT TIME ZONE 'America/New_York';
END;
$$;
