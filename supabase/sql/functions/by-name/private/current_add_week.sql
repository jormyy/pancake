-- Canonical SQL source for private.current_add_week.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.current_add_week(
  p_league_id uuid,
  p_league_season_id uuid,
  p_at timestamptz DEFAULT now()
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
  v_today date := (p_at AT TIME ZONE v_zone)::date;
  v_season_year int;
  v_week int;
  v_week_end date;
  v_previous_week int;
  v_previous_end date;
  v_next_start date;
  v_block int;
  v_bucket_start date;
  v_key int;
BEGIN
  SELECT season_year
    INTO v_season_year
    FROM league_seasons
   WHERE id = p_league_season_id
     AND league_id = p_league_id;

  SELECT weeks.week_number, weeks.week_end
    INTO v_week, v_week_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year
     AND weeks.week_start <= v_today
     AND weeks.week_end >= v_today
   ORDER BY weeks.week_number
   LIMIT 1;

  IF FOUND THEN
    RETURN QUERY SELECT v_week, (v_week_end + 1)::timestamp AT TIME ZONE v_zone;
    RETURN;
  END IF;

  SELECT weeks.week_number, weeks.week_end
    INTO v_previous_week, v_previous_end
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year
     AND weeks.week_end < v_today
   ORDER BY weeks.week_end DESC
   LIMIT 1;

  IF NOT FOUND THEN
    v_previous_week := 0;
    SELECT max(weeks.week_end)
      INTO v_previous_end
      FROM season_weeks AS weeks
     WHERE weeks.week_end < v_today
       AND weeks.season_year = (
         SELECT max(prior.season_year)
           FROM league_seasons AS prior
          WHERE prior.league_id = p_league_id
            AND prior.season_year < v_season_year
       );
  END IF;

  IF v_previous_end IS NULL THEN
    v_bucket_start := date_trunc('week', v_today)::date;
    v_key := to_char(v_bucket_start, 'J')::int;
  ELSE
    v_block := (v_today - v_previous_end - 1) / 7;
    v_bucket_start := v_previous_end + 1 + 7 * v_block;
    v_key := 1000 * (v_previous_week + 1) + v_block;
  END IF;

  SELECT min(weeks.week_start)
    INTO v_next_start
    FROM season_weeks AS weeks
   WHERE weeks.season_year = v_season_year
     AND weeks.week_start > v_today;

  RETURN QUERY SELECT v_key, least(v_bucket_start + 7, v_next_start)::timestamp AT TIME ZONE v_zone;
END;
$$;
