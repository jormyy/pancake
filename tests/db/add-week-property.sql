\set ON_ERROR_STOP on
BEGIN;
SET LOCAL statement_timeout = '120s';

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000d0001', 'authenticated', 'authenticated', 'add-week-property@example.test', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-0000000d0001', 'add_week_property', 'Add Week Property')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, weekly_add_limit)
VALUES
  ('00000000-0000-0000-0000-0000000d0101', 'Add Week Property', 'add-week-property', '00000000-0000-0000-0000-0000000d0001', 'active', 3),
  ('00000000-0000-0000-0000-0000000d0102', 'Add Week Off Cycle', 'add-week-off-cycle', '00000000-0000-0000-0000-0000000d0001', 'active', 3);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES
  ('00000000-0000-0000-0000-0000000d0201', '00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0001', 'commissioner', 'Property Team'),
  ('00000000-0000-0000-0000-0000000d0202', '00000000-0000-0000-0000-0000000d0102', '00000000-0000-0000-0000-0000000d0001', 'commissioner', 'Off Cycle Team');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-0000000d0397', '00000000-0000-0000-0000-0000000d0101', 2097, false),
  ('00000000-0000-0000-0000-0000000d0399', '00000000-0000-0000-0000-0000000d0101', 2099, false),
  ('00000000-0000-0000-0000-0000000d0400', '00000000-0000-0000-0000-0000000d0101', 2100, true),
  ('00000000-0000-0000-0000-0000000d0401', '00000000-0000-0000-0000-0000000d0102', 2101, true);

DELETE FROM public.season_weeks WHERE season_year BETWEEN 2097 AND 2101;
INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT season.year, week.number,
  CASE WHEN week.number = 1 THEN DATE '2024-10-22' ELSE week.monday END + season.shift,
  CASE WHEN week.number = 17 THEN week.monday + 13 ELSE week.monday + 6 END + season.shift
FROM (VALUES (2097, 26299), (2099, 27027)) AS season(year, shift)
CROSS JOIN LATERAL (
  SELECT number, DATE '2024-10-21' + 7 * (number - 1) + CASE WHEN number > 17 THEN 7 ELSE 0 END AS monday
    FROM generate_series(1, 24) AS number
) AS week
WHERE NOT (season.year = 2099 AND week.number = 10);

CREATE FUNCTION pg_temp.sweep(p_league uuid, p_season uuid, p_from timestamptz, p_to timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  v_zone text := private.add_week_timezone();
  v_year int := (SELECT season_year FROM public.league_seasons WHERE id = p_season);
  v_at timestamptz;
  v_week record;
  v_key int;
  v_reset timestamptz;
  v_bucket_start timestamptz;
  v_seen int[] := ARRAY[]::int[];
  v_days int;
BEGIN
  FOR v_at IN SELECT generate_series(p_from, p_to, interval '1 hour') LOOP
    SELECT * INTO v_week FROM private.current_add_week(p_league, p_season, v_at);
    IF v_week.resets_at IS NULL OR v_week.resets_at <= v_at THEN
      RAISE EXCEPTION 'season % at %: key % resets at %, so the limit never resets; private.current_add_week must return a reset instant after p_at for every instant', v_year, v_at, v_week.week_number, v_week.resets_at;
    END IF;
    IF v_key IS NULL OR v_week.week_number IS DISTINCT FROM v_key THEN
      IF v_key IS NOT NULL AND v_reset IS DISTINCT FROM v_at THEN
        RAISE EXCEPTION 'season % at %: key changed % -> % but the reported reset was %; private.current_add_week must change the key exactly at resets_at', v_year, v_at, v_key, v_week.week_number, v_reset;
      END IF;
      IF v_week.week_number = ANY (v_seen) THEN
        RAISE EXCEPTION 'season % at %: key % returns for a second bucket, so old adds count again; private.current_add_week must give every bucket its own key', v_year, v_at, v_week.week_number;
      END IF;
      v_seen := v_seen || v_week.week_number;
      v_bucket_start := v_at;
    ELSIF v_week.resets_at IS DISTINCT FROM v_reset THEN
      RAISE EXCEPTION 'season % at %: key % moved its reset from % to %; private.current_add_week must report one reset instant per bucket', v_year, v_at, v_key, v_reset, v_week.resets_at;
    END IF;
    v_days := (v_week.resets_at AT TIME ZONE v_zone)::date - (v_bucket_start AT TIME ZONE v_zone)::date;
    IF v_days > 7 AND NOT EXISTS (
      SELECT 1 FROM public.season_weeks AS weeks
       WHERE weeks.season_year = v_year
         AND weeks.week_number = v_week.week_number
         AND (weeks.week_start::timestamp AT TIME ZONE v_zone) <= v_bucket_start
         AND ((weeks.week_end + 1)::timestamp AT TIME ZONE v_zone) = v_week.resets_at
    ) THEN
      RAISE EXCEPTION 'season % at %: key % lasts % days from % to %; outside a scheduled week private.current_add_week must reset within 7 days', v_year, v_at, v_week.week_number, v_days, v_bucket_start, v_week.resets_at;
    END IF;
    v_key := v_week.week_number;
    v_reset := v_week.resets_at;
  END LOOP;
END $$;

DO $$
BEGIN
  PERFORM pg_temp.sweep('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0397', '2096-07-01 00:00Z', '2097-07-01 00:00Z');
  PERFORM pg_temp.sweep('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0399', '2098-07-01 00:00Z', '2099-07-01 00:00Z');
  PERFORM pg_temp.sweep('00000000-0000-0000-0000-0000000d0101', '00000000-0000-0000-0000-0000000d0400', '2099-07-01 00:00Z', '2100-01-01 00:00Z');
  PERFORM pg_temp.sweep('00000000-0000-0000-0000-0000000d0102', '00000000-0000-0000-0000-0000000d0401', '2100-07-15 13:00Z', '2101-01-15 00:00Z');
END $$;

DO $$
DECLARE v_unowned text;
BEGIN
  SELECT string_agg(p.oid::regprocedure::text, ', ' ORDER BY p.oid::regprocedure::text)
    INTO v_unowned
    FROM pg_proc AS p
    JOIN pg_namespace AS n ON n.oid = p.pronamespace
   WHERE n.nspname IN ('public', 'private')
     AND p.prosrc ~* 'weekly_add_counts'
     AND p.prosrc !~* 'current_add_week';
  IF v_unowned IS NOT NULL THEN
    RAISE EXCEPTION 'functions read weekly_add_counts without private.current_add_week: %; take the week key from private.current_add_week', v_unowned;
  END IF;
END $$;

SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0001', true);
DO $$
DECLARE
  v_league uuid := '00000000-0000-0000-0000-0000000d0102';
  v_season uuid := '00000000-0000-0000-0000-0000000d0401';
  v_member uuid := '00000000-0000-0000-0000-0000000d0202';
  v_week record;
  v_state record;
BEGIN
  SELECT * INTO v_week FROM private.current_add_week(v_league, v_season);
  PERFORM private.assert_weekly_add_available(v_league, v_season, v_member);
  PERFORM private.consume_weekly_add(v_league, v_season, v_member);
  PERFORM private.assert_weekly_add_available(v_league, v_season, v_member);
  PERFORM private.consume_weekly_add(v_league, v_season, v_member);
  IF (SELECT array_agg(week_number || ':' || add_count) FROM public.weekly_add_counts WHERE league_season_id = v_season) IS DISTINCT FROM ARRAY[v_week.week_number || ':2'] THEN
    RAISE EXCEPTION 'add and consume wrote %, expected week % with 2 adds', (SELECT array_agg(week_number || ':' || add_count) FROM public.weekly_add_counts WHERE league_season_id = v_season), v_week.week_number;
  END IF;
  SELECT * INTO v_state FROM public.get_member_transaction_state(v_member, v_league);
  IF v_state.week_number IS DISTINCT FROM v_week.week_number OR v_state.weekly_add_count <> 2 OR v_state.add_limit_resets_at IS DISTINCT FROM v_week.resets_at THEN
    RAISE EXCEPTION 'member state saw week % count % reset %, expected week % count 2 reset %', v_state.week_number, v_state.weekly_add_count, v_state.add_limit_resets_at, v_week.week_number, v_week.resets_at;
  END IF;
  IF public.commissioner_override_weekly_add_count_atomic(v_league, v_member, 3) <> 3 THEN
    RAISE EXCEPTION 'commissioner override did not report 3 adds';
  END IF;
  IF private.weekly_add_limit_reached((SELECT add_count FROM public.weekly_add_counts WHERE league_season_id = v_season AND week_number = v_week.week_number), 3) IS NOT TRUE THEN
    RAISE EXCEPTION 'commissioner override left %, expected week % at 3 adds', (SELECT array_agg(week_number || ':' || add_count) FROM public.weekly_add_counts WHERE league_season_id = v_season), v_week.week_number;
  END IF;
  BEGIN
    PERFORM private.assert_weekly_add_available(v_league, v_season, v_member);
    RAISE EXCEPTION 'a full off-cycle week accepted another add';
  EXCEPTION WHEN SQLSTATE 'PA001' THEN NULL;
  END;
  RAISE NOTICE 'add week is a total function of time';
END $$;

ROLLBACK;
