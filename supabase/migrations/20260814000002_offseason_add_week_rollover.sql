-- After the season's final scheduled week, private.current_add_week_number
-- previously froze at max(week_number), so weekly add limits never reset
-- and members who hit the cap in the last week stayed blocked forever.
-- The week number now keeps advancing every 7 days past the final week_end.

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
  v_last_end date;
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

  SELECT max(week_number), max(week_end)
    INTO v_week, v_last_end
    FROM season_weeks
   WHERE season_year = v_season_year;

  -- Past the final scheduled week the number keeps advancing every 7 days,
  -- so weekly add limits still reset in the offseason instead of freezing
  -- members at the last in-season week's count forever.
  IF v_week IS NOT NULL AND v_last_end IS NOT NULL AND v_today > v_last_end THEN
    RETURN v_week + 1 + ((v_today - v_last_end - 1) / 7);
  END IF;

  RETURN COALESCE(v_week, 1);
END;
$$;
