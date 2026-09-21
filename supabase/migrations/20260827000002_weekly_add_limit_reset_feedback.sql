-- Weekly add limit reset feedback.
--
-- The server now reports when the current add week ends (midnight ET the day
-- after the scheduled week, or the 7-day cadence past the schedule) so every
-- pickup entry point can explain a blocked add and show the next eligible time.
-- The rejection message carries the same instant, and get_member_transaction_state
-- returns it with the league's add-week time zone.


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

REVOKE ALL ON FUNCTION private.weekly_add_limit_resets_at(uuid, uuid) FROM PUBLIC;

DROP FUNCTION IF EXISTS private.weekly_add_limit_message(int, int);

CREATE OR REPLACE FUNCTION private.weekly_add_limit_message(
  p_used int,
  p_limit int,
  p_resets_at timestamptz DEFAULT NULL
)
RETURNS text
LANGUAGE sql
STABLE
AS $$
  SELECT format('Weekly add limit reached (%s/%s adds used this week).', p_used, p_limit)
    || CASE
         WHEN p_resets_at IS NULL THEN ''
         ELSE format(
           ' Adds reset %s ET.',
           to_char(p_resets_at AT TIME ZONE 'America/New_York', 'Dy, Mon FMDD "at" FMHH12:MI AM')
         )
       END;
$$;

CREATE OR REPLACE FUNCTION private.assert_weekly_add_available(
  p_league_id uuid,
  p_league_season_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_limit int;
  v_week int;
  v_used int;
BEGIN
  SELECT weekly_add_limit
    INTO v_limit
    FROM leagues
   WHERE id = p_league_id
   FOR UPDATE;

  IF v_limit IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, p_league_season_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    p_league_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  SELECT count_row.add_count
    INTO v_used
    FROM weekly_add_counts AS count_row
   WHERE count_row.league_id = p_league_id
     AND count_row.league_season_id = p_league_season_id
     AND count_row.member_id = p_member_id
     AND count_row.week_number = v_week
   FOR UPDATE;

  IF COALESCE(v_used, 0) >= v_limit THEN
    RAISE EXCEPTION '%', private.weekly_add_limit_message(
      COALESCE(v_used, 0),
      v_limit,
      private.weekly_add_limit_resets_at(p_league_id, p_league_season_id)
    )
      USING ERRCODE = 'P0001';
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.get_member_transaction_state(uuid, uuid);

CREATE OR REPLACE FUNCTION public.get_member_transaction_state(
  p_member_id uuid,
  p_league_id uuid
)
RETURNS TABLE (
  league_season_id uuid,
  week_number int,
  weekly_add_limit int,
  weekly_add_count int,
  waiver_mode text,
  faab_starting_budget int,
  faab_balance int,
  add_limit_resets_at timestamptz,
  add_week_timezone text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id uuid := auth.uid();
  v_season_id uuid;
  v_week int;
  v_balance int;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'Not authenticated.'
      USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM league_members
   WHERE id = p_member_id
     AND league_id = p_league_id
     AND user_id = v_user_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Access denied.'
      USING ERRCODE = '42501';
  END IF;

  SELECT id
    INTO v_season_id
    FROM league_seasons
   WHERE league_id = p_league_id
     AND is_current = true
   LIMIT 1;

  IF v_season_id IS NULL THEN
    RETURN;
  END IF;

  v_week := private.current_add_week_number(p_league_id, v_season_id);
  v_balance := private.ensure_faab_balance(p_league_id, v_season_id, p_member_id);

  INSERT INTO weekly_add_counts (
    league_id,
    league_season_id,
    member_id,
    week_number,
    add_count
  )
  VALUES (
    p_league_id,
    v_season_id,
    p_member_id,
    v_week,
    0
  )
  ON CONFLICT ON CONSTRAINT weekly_add_counts_league_id_league_season_id_member_id_week_key DO NOTHING;

  RETURN QUERY
  SELECT
    v_season_id,
    v_week,
    league.weekly_add_limit,
    count_row.add_count,
    league.waiver_mode,
    league.faab_starting_budget,
    v_balance,
    private.weekly_add_limit_resets_at(p_league_id, v_season_id),
    'America/New_York'::text
  FROM leagues AS league
  JOIN weekly_add_counts AS count_row
    ON count_row.league_id = league.id
   AND count_row.league_season_id = v_season_id
   AND count_row.member_id = p_member_id
   AND count_row.week_number = v_week
  WHERE league.id = p_league_id;
END;
$$;

REVOKE ALL ON FUNCTION public.get_member_transaction_state(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.get_member_transaction_state(uuid, uuid) TO authenticated, service_role;
