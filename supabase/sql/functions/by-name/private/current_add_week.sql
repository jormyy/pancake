-- Canonical SQL source for private.current_add_week.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.current_add_week(
  p_league_id uuid,
  p_league_season_id uuid
)
RETURNS TABLE (
  week_number int,
  resets_at timestamptz
)
LANGUAGE plpgsql
STABLE
SET search_path = public
AS $$
DECLARE
  v_zone text := private.add_week_timezone();
  v_today date := (now() AT TIME ZONE private.add_week_timezone())::date;
  v_season_year int;
  v_week int;
  v_week_end date;
  v_last_week int;
  v_last_end date;
  v_elapsed_weeks int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  IF v_season_year IS NULL THEN
    RETURN QUERY SELECT 1, NULL::timestamptz;
    RETURN;
  END IF;

  -- Inside a scheduled week, or before the next scheduled week starts, the
  -- count belongs to that week and resets at midnight the day after it ends.
  SELECT weeks.week_number, weeks.week_end
    INTO v_week, v_week_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year
     AND weeks.week_start <= v_today
     AND weeks.week_end >= v_today
   ORDER BY weeks.week_number
   LIMIT 1;

  IF v_week IS NULL THEN
    SELECT weeks.week_number, weeks.week_end
      INTO v_week, v_week_end
      FROM season_weeks AS weeks
     WHERE weeks.season_year = v_season_year
       AND weeks.week_end >= v_today
     ORDER BY weeks.week_start
     LIMIT 1;
  END IF;

  IF v_week IS NOT NULL THEN
    RETURN QUERY SELECT v_week, (v_week_end + 1)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  -- Past the final scheduled week the number keeps advancing every 7 days, so
  -- limits still reset in the playoffs and the offseason.
  SELECT max(weeks.week_number), max(weeks.week_end)
    INTO v_last_week, v_last_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year;

  IF v_last_week IS NOT NULL AND v_last_end IS NOT NULL AND v_today > v_last_end THEN
    v_elapsed_weeks := (v_today - v_last_end - 1) / 7;
    RETURN QUERY SELECT v_last_week + 1 + v_elapsed_weeks,
      (v_last_end + 1 + (v_elapsed_weeks + 1) * 7)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  -- A new season with no schedule yet (rollover happens months before the NBA
  -- publishes one) keeps the 7-day cadence anchored on the prior season. The
  -- 1000 offset keeps these numbers clear of the real ones that arrive in October.
  IF v_last_week IS NULL THEN
    SELECT max(weeks.week_end)
      INTO v_last_end
      FROM season_weeks AS weeks
     WHERE weeks.season_year = (
       SELECT max(prior.season_year)
         FROM league_seasons AS prior
        WHERE prior.league_id = p_league_id
          AND prior.season_year < v_season_year
     );

    IF v_last_end IS NOT NULL AND v_today > v_last_end THEN
      v_elapsed_weeks := (v_today - v_last_end - 1) / 7;
      RETURN QUERY SELECT 1000 + v_elapsed_weeks,
        (v_last_end + 1 + (v_elapsed_weeks + 1) * 7)::timestamp AT TIME ZONE v_zone;
      RETURN;
    END IF;
  END IF;

  RETURN QUERY SELECT COALESCE(v_last_week, 1), NULL::timestamptz;
END;
$$;
