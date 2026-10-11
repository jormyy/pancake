-- Canonical SQL source for private.assert_playoff_window.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION private.assert_playoff_window(p_year int, p_start int, p_rounds int[], p_include_regular boolean DEFAULT false)
RETURNS void
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
  v_end bigint := p_start::bigint + (SELECT sum(value::bigint) FROM unnest(p_rounds) AS value) - 1;
  v_first int := CASE WHEN p_include_regular THEN 1 ELSE p_start END;
  v_max int;
  v_count int;
BEGIN
  SELECT max(week_number) INTO v_max FROM public.season_weeks WHERE season_year = p_year;
  IF v_max IS NULL THEN
    RAISE EXCEPTION 'The season % calendar is unavailable. Load the calendar before changing or generating the schedule.', p_year USING ERRCODE = '22023';
  END IF;
  IF p_start IS NULL OR p_start < 1 OR v_end IS NULL OR v_end > v_max OR v_end < p_start THEN
    RAISE EXCEPTION 'Playoffs must start at a positive whole week and finish by week % in season %.', v_max, p_year USING ERRCODE = '22023';
  END IF;
  SELECT count(*) INTO v_count FROM public.season_weeks
   WHERE season_year = p_year AND week_number BETWEEN v_first AND v_end;
  IF v_count <> v_end - v_first + 1 THEN
    RAISE EXCEPTION 'The season % calendar has a missing week in the requested schedule (% through %).', p_year, v_first, v_end USING ERRCODE = '22023';
  END IF;
END;
$$;
