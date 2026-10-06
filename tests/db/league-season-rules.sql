-- League season rules: a new league is set up for the season it will play,
-- its commissioner holds a waiver spot, a setup league that never started
-- moves to the next season, and the trade deadline repeats every season.
BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at
)
SELECT
  ('00000000-0000-0000-0000-0000000990' || suffix)::uuid, 'authenticated', 'authenticated',
  'season-rules-' || suffix || '@example.test', 'x', now(), '{}'::jsonb,
  jsonb_build_object('username', 'season_rules_' || suffix), now(), now()
FROM unnest(ARRAY['01', '02']) AS suffix
ON CONFLICT (id) DO NOTHING;

-- Fixture calendar far from real data: season 3101 runs 3100-10-20 to 3101-04-11.
INSERT INTO public.season_weeks (season_year, week_number, week_start, week_end)
VALUES
  (3101, 1, date '3100-10-20', date '3100-10-26'),
  (3101, 25, date '3101-04-05', date '3101-04-11');

DO $$
BEGIN
  -- A deadline keeps its month and day and lands inside the given season.
  IF private.trade_deadline_for_season(date '2000-02-11', 3102) <> date '3102-02-11' THEN
    RAISE EXCEPTION 'February deadline not anchored to the season year';
  END IF;
  IF private.trade_deadline_for_season(date '3101-12-15', 3103) <> date '3102-12-15' THEN
    RAISE EXCEPTION 'December deadline not anchored to the year the season starts';
  END IF;
  IF private.trade_deadline_for_season(date '2000-02-29', 3101) <> date '3101-02-28' THEN
    RAISE EXCEPTION 'leap-day deadline not clamped in a non-leap season';
  END IF;
  IF private.trade_deadline_for_season(NULL, 3101) IS NOT NULL THEN
    RAISE EXCEPTION 'missing deadline produced a date';
  END IF;

  -- The calendar season flips on Oct 1 ET; once its last week ends, setup
  -- targets the next season.
  IF private.setup_season_year_et(timestamptz '3101-03-01 12:00 America/New_York') <> 3101 THEN
    RAISE EXCEPTION 'setup season moved before the season ended';
  END IF;
  IF private.setup_season_year_et(timestamptz '3101-05-01 12:00 America/New_York') <> 3102 THEN
    RAISE EXCEPTION 'setup season stayed on a finished season';
  END IF;
  IF private.setup_season_year_et(timestamptz '3101-10-02 12:00 America/New_York') <> 3102 THEN
    RAISE EXCEPTION 'setup season ignored the October flip';
  END IF;
END $$;

-- create_league: the commissioner gets the first waiver spot, and a joiner
-- lines up behind them.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000099001","role":"authenticated"}', true);
SELECT (public.create_league('Season Rules League', 'Commish Team', 200) ->> 'id') AS created_league_id \gset
SELECT invite_code AS created_invite_code FROM public.leagues WHERE id = :'created_league_id' \gset
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000099002","role":"authenticated"}', true);
SELECT public.join_league_by_invite_code(:'created_invite_code', 'Joiner Team');

SELECT set_config('season_rules.created_league_id', :'created_league_id', true);

DO $$
DECLARE
  v_league_id uuid := current_setting('season_rules.created_league_id')::uuid;
  v_order text;
BEGIN
  IF (SELECT season_year FROM public.league_seasons WHERE league_id = v_league_id AND is_current)
     <> private.setup_season_year_et() THEN
    RAISE EXCEPTION 'create_league did not use the setup season';
  END IF;

  SELECT string_agg(member.role::text || ':' || priority.priority, ',' ORDER BY priority.priority)
    INTO v_order
    FROM public.waiver_priorities AS priority
    JOIN public.league_members AS member ON member.id = priority.member_id
   WHERE priority.league_id = v_league_id;
  IF v_order IS DISTINCT FROM 'commissioner:1,manager:2' THEN
    RAISE EXCEPTION 'waiver order after create and join was %', v_order;
  END IF;
END $$;

-- Three leagues on finished season 3101: an untouched setup league, a setup
-- league that already rostered a player, and an active league.
INSERT INTO public.leagues (id, name, slug, invite_code, commissioner_id, status, trade_deadline)
VALUES
  ('00000000-0000-0000-0000-000000099101', 'Rules Setup', 'rules-setup', 'RULESSETUP000001',
   '00000000-0000-0000-0000-000000099001', 'setup', date '3101-02-11'),
  ('00000000-0000-0000-0000-000000099102', 'Rules Rostered', 'rules-rostered', 'RULESROSTER00002',
   '00000000-0000-0000-0000-000000099001', 'setup', date '3101-02-11'),
  ('00000000-0000-0000-0000-000000099103', 'Rules Active', 'rules-active', 'RULESACTIVE00003',
   '00000000-0000-0000-0000-000000099001', 'active', date '3101-02-11');

INSERT INTO public.league_members (id, league_id, user_id, role, team_name)
SELECT
  ('00000000-0000-0000-0000-0000000992' || right(league_suffix, 2))::uuid,
  ('00000000-0000-0000-0000-000000099' || league_suffix)::uuid,
  '00000000-0000-0000-0000-000000099001', 'commissioner', 'Fixture Team'
FROM unnest(ARRAY['101', '102', '103']) AS league_suffix;

INSERT INTO public.league_seasons (id, league_id, season_year, is_current)
SELECT
  ('00000000-0000-0000-0000-0000000993' || right(league_suffix, 2))::uuid,
  ('00000000-0000-0000-0000-000000099' || league_suffix)::uuid,
  3101, true
FROM unnest(ARRAY['101', '102', '103']) AS league_suffix;

INSERT INTO public.draft_picks (league_id, season_year, round, original_owner_id, current_owner_id)
SELECT
  ('00000000-0000-0000-0000-000000099' || league_suffix)::uuid,
  year_value, round_value,
  ('00000000-0000-0000-0000-0000000992' || right(league_suffix, 2))::uuid,
  ('00000000-0000-0000-0000-0000000992' || right(league_suffix, 2))::uuid
FROM unnest(ARRAY['101', '102', '103']) AS league_suffix
CROSS JOIN generate_series(3102, 3106) AS year_value
CROSS JOIN generate_series(1, 3) AS round_value;

INSERT INTO public.players (id, first_name, last_name, position, eligible_positions)
VALUES ('00000000-0000-0000-0000-000000099401', 'Season', 'Rules', 'PG', ARRAY['PG']);

INSERT INTO public.roster_players (league_id, league_season_id, member_id, player_id, acquired_via)
VALUES (
  '00000000-0000-0000-0000-000000099102', '00000000-0000-0000-0000-000000099302',
  '00000000-0000-0000-0000-000000099202', '00000000-0000-0000-0000-000000099401', 'draft'
);

SELECT private.roll_setup_league_seasons(timestamptz '3101-05-01 12:00 America/New_York') AS rolled \gset

DO $$
DECLARE
  v_summary text;
BEGIN
  SELECT season.season_year || ' picks ' || min(pick.season_year) || '-' || max(pick.season_year)
         || '/' || count(pick.id) || ' deadline ' || league.trade_deadline
    INTO v_summary
    FROM public.leagues AS league
    JOIN public.league_seasons AS season ON season.league_id = league.id AND season.is_current
    JOIN public.draft_picks AS pick ON pick.league_id = league.id
   WHERE league.id = '00000000-0000-0000-0000-000000099101'
   GROUP BY season.season_year, league.trade_deadline;
  IF v_summary IS DISTINCT FROM '3102 picks 3103-3107/15 deadline 3102-02-11' THEN
    RAISE EXCEPTION 'untouched setup league did not move to the next season: %', v_summary;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.league_seasons
     WHERE league_id IN ('00000000-0000-0000-0000-000000099102', '00000000-0000-0000-0000-000000099103')
       AND season_year <> 3101
  ) OR EXISTS (
    SELECT 1 FROM public.leagues
     WHERE id IN ('00000000-0000-0000-0000-000000099102', '00000000-0000-0000-0000-000000099103')
       AND trade_deadline <> date '3101-02-11'
  ) THEN
    RAISE EXCEPTION 'a league that already started play was moved';
  END IF;
END $$;

-- The commissioner sets the deadline as a month and day; it lands in the
-- league's current season, an old full date is re-anchored, and null clears it.
SELECT set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000099001","role":"authenticated"}', true);

DO $$
DECLARE
  v_league_id uuid := '00000000-0000-0000-0000-000000099101';
  v_deadline date;
BEGIN
  PERFORM public.update_league_settings_atomic(v_league_id, '{"trade_deadline":"03-04"}');
  SELECT trade_deadline INTO v_deadline FROM public.leagues WHERE id = v_league_id;
  IF v_deadline IS DISTINCT FROM date '3102-03-04' THEN
    RAISE EXCEPTION 'month-day deadline stored as %', v_deadline;
  END IF;

  PERFORM public.update_league_settings_atomic(v_league_id, '{"trade_deadline":"12-15"}');
  SELECT trade_deadline INTO v_deadline FROM public.leagues WHERE id = v_league_id;
  IF v_deadline IS DISTINCT FROM date '3101-12-15' THEN
    RAISE EXCEPTION 'December deadline stored as %', v_deadline;
  END IF;

  PERFORM public.update_league_settings_atomic(v_league_id, '{"trade_deadline":"2027-02-11"}');
  SELECT trade_deadline INTO v_deadline FROM public.leagues WHERE id = v_league_id;
  IF v_deadline IS DISTINCT FROM date '3102-02-11' THEN
    RAISE EXCEPTION 'full-date deadline stored as %', v_deadline;
  END IF;

  PERFORM public.update_league_settings_atomic(v_league_id, '{"weekly_add_limit":3}');
  SELECT trade_deadline INTO v_deadline FROM public.leagues WHERE id = v_league_id;
  IF v_deadline IS DISTINCT FROM date '3102-02-11' THEN
    RAISE EXCEPTION 'an unrelated settings save changed the deadline to %', v_deadline;
  END IF;

  PERFORM public.update_league_settings_atomic(v_league_id, '{"trade_deadline":null}');
  SELECT trade_deadline INTO v_deadline FROM public.leagues WHERE id = v_league_id;
  IF v_deadline IS NOT NULL THEN
    RAISE EXCEPTION 'null did not clear the deadline';
  END IF;

  BEGIN
    PERFORM public.update_league_settings_atomic(v_league_id, '{"trade_deadline":"02-30"}');
    RAISE EXCEPTION 'impossible date accepted';
  EXCEPTION WHEN invalid_parameter_value THEN
    NULL;
  END;
END $$;

-- Advancing a season carries the deadline into the new season.
UPDATE public.leagues
   SET status = 'playoffs', trade_deadline = date '3101-02-11'
 WHERE id = '00000000-0000-0000-0000-000000099103';

SELECT new_year FROM public.advance_season_atomic('00000000-0000-0000-0000-000000099103') \gset

DO $$
BEGIN
  IF (SELECT trade_deadline FROM public.leagues WHERE id = '00000000-0000-0000-0000-000000099103')
     IS DISTINCT FROM date '3102-02-11' THEN
    RAISE EXCEPTION 'advancing the season left the deadline in the old season';
  END IF;
END $$;

ROLLBACK;
