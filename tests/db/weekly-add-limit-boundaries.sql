-- Weekly add limit reset boundaries: the reset instant the server reports (and
-- puts in its rejection message) must follow the add-week rule owned by
-- private.current_add_week for every schedule shape.
-- Runs inside one transaction and rolls back.
BEGIN;

INSERT INTO auth.users (id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
VALUES ('00000000-0000-0000-0000-0000000c0001', 'authenticated', 'authenticated', 'add-limit@example.test', 'x', now(), '{}', '{}', now(), now());
INSERT INTO public.profiles (id, username, display_name)
VALUES ('00000000-0000-0000-0000-0000000c0001', 'add_limit_user', 'Add Limit User')
ON CONFLICT (id) DO NOTHING;
INSERT INTO public.leagues (id, name, slug, commissioner_id, status, weekly_add_limit)
VALUES ('00000000-0000-0000-0000-0000000c0101', 'Add Limit Boundaries', 'add-limit-boundaries', '00000000-0000-0000-0000-0000000c0001', 'active', 1);
INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
VALUES ('00000000-0000-0000-0000-0000000c0201', '00000000-0000-0000-0000-0000000c0101', '00000000-0000-0000-0000-0000000c0001', 'commissioner', 'Boundary Team');
INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
VALUES
  ('00000000-0000-0000-0000-0000000c0300', '00000000-0000-0000-0000-0000000c0101', 2097, false),
  ('00000000-0000-0000-0000-0000000c0301', '00000000-0000-0000-0000-0000000c0101', 2098, true);

CREATE TEMP TABLE add_limit_ids AS
SELECT
  '00000000-0000-0000-0000-0000000c0101'::uuid AS league_id,
  '00000000-0000-0000-0000-0000000c0301'::uuid AS season_id,
  '00000000-0000-0000-0000-0000000c0201'::uuid AS member_id,
  (now() AT TIME ZONE 'America/New_York')::date AS today;

CREATE OR REPLACE FUNCTION pg_temp.et_midnight(p_date date) RETURNS timestamptz LANGUAGE sql AS $$
  SELECT p_date::timestamp AT TIME ZONE 'America/New_York'
$$;

CREATE OR REPLACE FUNCTION pg_temp.expect_reset(p_case text, p_expected_week int, p_expected_reset timestamptz) RETURNS void LANGUAGE plpgsql AS $$
DECLARE ids add_limit_ids%ROWTYPE; v_week int; v_reset timestamptz;
BEGIN
  SELECT * INTO ids FROM add_limit_ids;
  SELECT week.week_number, week.resets_at INTO v_week, v_reset FROM private.current_add_week(ids.league_id, ids.season_id) AS week;
  IF v_week IS DISTINCT FROM p_expected_week THEN
    RAISE EXCEPTION '%: week % expected %', p_case, v_week, p_expected_week;
  END IF;
  IF v_reset IS DISTINCT FROM p_expected_reset THEN
    RAISE EXCEPTION '%: reset % expected %', p_case, v_reset, p_expected_reset;
  END IF;
END $$;

-- A: today sits inside week 2 -> resets the day after week 2 ends.
INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT 2098, 1, ids.today - 10, ids.today - 4 FROM add_limit_ids AS ids
UNION ALL SELECT 2098, 2, ids.today - 3, ids.today + 3 FROM add_limit_ids AS ids
UNION ALL SELECT 2098, 3, ids.today + 4, ids.today + 10 FROM add_limit_ids AS ids;
SELECT pg_temp.expect_reset('A inside week', 2, pg_temp.et_midnight(ids.today + 4)) FROM add_limit_ids AS ids;

-- B: today is the last day of week 2 -> resets tomorrow.
UPDATE public.season_weeks SET week_start = (SELECT today - 6 FROM add_limit_ids), week_end = (SELECT today FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 2;
UPDATE public.season_weeks SET week_start = (SELECT today + 1 FROM add_limit_ids), week_end = (SELECT today + 7 FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 3;
SELECT pg_temp.expect_reset('B last day of week', 2, pg_temp.et_midnight(ids.today + 1)) FROM add_limit_ids AS ids;

-- C: today is the first day of week 3 -> resets in seven days.
UPDATE public.season_weeks SET week_start = (SELECT today - 7 FROM add_limit_ids), week_end = (SELECT today - 1 FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 2;
UPDATE public.season_weeks SET week_start = (SELECT today FROM add_limit_ids), week_end = (SELECT today + 6 FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 3;
SELECT pg_temp.expect_reset('C first day of week', 3, pg_temp.et_midnight(ids.today + 7)) FROM add_limit_ids AS ids;

-- D: a gap before the next scheduled week counts toward that week.
UPDATE public.season_weeks SET week_start = (SELECT today + 2 FROM add_limit_ids), week_end = (SELECT today + 8 FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 3;
SELECT pg_temp.expect_reset('D gap before next week', 3, pg_temp.et_midnight(ids.today + 9)) FROM add_limit_ids AS ids;

-- E: past the final scheduled week the count rolls every seven days.
DELETE FROM public.season_weeks WHERE season_year = 2098 AND week_number IN (2, 3);
-- week 1 ended today - 4: buckets [today-3, today+3], so the reset is today + 4 and the week number is 2.
SELECT pg_temp.expect_reset('E past schedule', 2, pg_temp.et_midnight(ids.today + 4)) FROM add_limit_ids AS ids;
UPDATE public.season_weeks SET week_start = (SELECT today - 16 FROM add_limit_ids), week_end = (SELECT today - 10 FROM add_limit_ids) WHERE season_year = 2098 AND week_number = 1;
-- week 1 ended today - 10: buckets [today-9, today-3], [today-2, today+4], so week 3 resets today + 5.
SELECT pg_temp.expect_reset('E second offseason bucket', 3, pg_temp.et_midnight(ids.today + 5)) FROM add_limit_ids AS ids;

-- F: a new season with no schedule yet anchors on the prior season's last week.
UPDATE public.season_weeks SET season_year = 2097 WHERE season_year = 2098;
SELECT pg_temp.expect_reset('F unscheduled new season', 1001, pg_temp.et_midnight(ids.today + 5)) FROM add_limit_ids AS ids;

-- G: no schedule anywhere -> week 1 with no known reset.
DELETE FROM public.season_weeks WHERE season_year IN (2097, 2098);
SELECT pg_temp.expect_reset('G no schedule', 1, NULL);

-- H: the rejection message and the member state carry the same reset instant,
-- the same sentence, and the same label.
INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
SELECT 2098, 5, ids.today - 2, ids.today + 4 FROM add_limit_ids AS ids;
INSERT INTO public.weekly_add_counts (league_id, league_season_id, member_id, week_number, add_count)
SELECT ids.league_id, ids.season_id, ids.member_id, 5, 1 FROM add_limit_ids AS ids;
SELECT set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0001', true);
DO $$
DECLARE ids add_limit_ids%ROWTYPE; v_message text; v_state record; v_expected timestamptz; v_expected_text text;
BEGIN
  SELECT * INTO ids FROM add_limit_ids;
  v_expected := pg_temp.et_midnight(ids.today + 5);
  -- Independent rendering of the same instant: weekday, month, day, midnight.
  v_expected_text := trim(to_char(ids.today + 5, 'Dy')) || ', ' || trim(to_char(ids.today + 5, 'Mon')) || ' '
    || extract(day FROM ids.today + 5)::int || ' at 12:00 AM';
  BEGIN
    PERFORM private.assert_weekly_add_available(ids.league_id, ids.season_id, ids.member_id);
    RAISE EXCEPTION 'H: limit was not enforced';
  EXCEPTION
    WHEN SQLSTATE 'PA001' THEN v_message := SQLERRM;
  END;
  IF v_message <> 'Weekly add limit reached (1/1 adds used this week). Adds reset ' || v_expected_text || ' ET.' THEN
    RAISE EXCEPTION 'H: unexpected message: %', v_message;
  END IF;
  SELECT * INTO v_state FROM public.get_member_transaction_state(ids.member_id, ids.league_id);
  IF v_state.add_limit_resets_at IS DISTINCT FROM v_expected
     OR v_state.add_limit_message IS DISTINCT FROM v_message
     OR v_state.add_limit_resets_label IS DISTINCT FROM v_expected_text || ' ET' THEN
    RAISE EXCEPTION 'H: state % / % / % expected % / %', v_state.add_limit_resets_at, v_state.add_limit_message, v_state.add_limit_resets_label, v_expected, v_message;
  END IF;
  IF v_state.weekly_add_count <> 1 OR v_state.weekly_add_limit <> 1 OR v_state.week_number <> 5 THEN
    RAISE EXCEPTION 'H: state counters wrong: % / % / %', v_state.weekly_add_count, v_state.weekly_add_limit, v_state.week_number;
  END IF;
  RAISE NOTICE 'weekly add limit boundaries hold';
END $$;

ROLLBACK;
