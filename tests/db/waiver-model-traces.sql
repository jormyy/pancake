SELECT count(pg_terminate_backend(pid)) AS stale_holders FROM pg_stat_activity WHERE application_name = 'pancake-waiver-trace-holder';

CREATE TEMP TABLE trace_ids (name text PRIMARY KEY, id uuid NOT NULL);
INSERT INTO trace_ids VALUES
  ('L1', '00000000-0000-0000-0000-000000060801'), ('L2', '00000000-0000-0000-0000-000000060802'),
  ('S1', '00000000-0000-0000-0000-000000060811'), ('S2', '00000000-0000-0000-0000-000000060812'),
  ('A', '00000000-0000-0000-0000-000000060821'), ('B', '00000000-0000-0000-0000-000000060822'),
  ('C', '00000000-0000-0000-0000-000000060823'),
  ('p1', '00000000-0000-0000-0000-000000060831'), ('p2', '00000000-0000-0000-0000-000000060832'),
  ('p3', '00000000-0000-0000-0000-000000060833'), ('p4', '00000000-0000-0000-0000-000000060834'),
  ('pd', '00000000-0000-0000-0000-000000060835'),
  ('c1', '00000000-0000-0000-0000-000000060841'), ('c2', '00000000-0000-0000-0000-000000060842'),
  ('c3', '00000000-0000-0000-0000-000000060843'), ('c4', '00000000-0000-0000-0000-000000060844'),
  ('c5', '00000000-0000-0000-0000-000000060845');

CREATE FUNCTION pg_temp.id(p_name text) RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT id FROM trace_ids WHERE name = p_name
$$;

CREATE FUNCTION pg_temp.claim(p_name text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT status::text FROM public.waiver_claims WHERE id = pg_temp.id(p_name)
$$;

CREATE FUNCTION pg_temp.owner(p_player text) RETURNS text LANGUAGE sql STABLE AS $$
  SELECT coalesce((SELECT t.name FROM public.roster_players rp JOIN trace_ids t ON t.id = rp.member_id
    WHERE rp.player_id = pg_temp.id(p_player)), 'none')
$$;

CREATE FUNCTION pg_temp.faab(p_team text) RETURNS int LANGUAGE sql STABLE AS $$
  SELECT balance FROM public.faab_balances WHERE member_id = pg_temp.id(p_team)
$$;

CREATE FUNCTION pg_temp.run_until_idle() RETURNS text[] LANGUAGE plpgsql AS $$
DECLARE
  v_awarded text[] := ARRAY[]::text[];
  v_rows int;
BEGIN
  LOOP
    WITH result AS (SELECT * FROM public.process_next_waiver_claim_atomic((now() AT TIME ZONE 'America/Los_Angeles')::date))
    SELECT count(*), v_awarded || coalesce(array_agg(t.name ORDER BY t.name) FILTER (WHERE result.status = 'succeeded'), ARRAY[]::text[])
      INTO v_rows, v_awarded
      FROM result LEFT JOIN trace_ids t ON t.id = result.claim_id;
    EXIT WHEN v_rows = 0;
  END LOOP;
  RETURN v_awarded;
END;
$$;

CREATE FUNCTION pg_temp.cleanup() RETURNS void LANGUAGE sql AS $$
  DELETE FROM public.leagues WHERE id IN (pg_temp.id('L1'), pg_temp.id('L2'));
  DELETE FROM public.players WHERE id IN (SELECT id FROM trace_ids WHERE name LIKE 'p%');
  DELETE FROM auth.users WHERE id IN (pg_temp.id('A'), pg_temp.id('B'), pg_temp.id('C'));
$$;

SELECT pg_temp.cleanup();

DO $$
DECLARE
  v_run1 date := (now() AT TIME ZONE 'America/Los_Angeles')::date - 2;
BEGIN
  INSERT INTO auth.users(id, aud, role, email, encrypted_password, email_confirmed_at, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  SELECT pg_temp.id(team), 'authenticated', 'authenticated', team || '-waiver-trace@example.test', 'x', now(), '{}', '{}', now(), now()
    FROM unnest(ARRAY['A', 'B', 'C']) team;
  INSERT INTO public.leagues(id, name, slug, commissioner_id, status, waiver_mode, roster_size, weekly_add_limit, faab_starting_budget)
  VALUES (pg_temp.id('L1'), 'Waiver trace one', 'waiver-trace-one', pg_temp.id('A'), 'active', 'faab', 1, NULL, 5),
    (pg_temp.id('L2'), 'Waiver trace two', 'waiver-trace-two', pg_temp.id('C'), 'active', 'faab', 1, NULL, 5);
  INSERT INTO public.league_seasons(id, league_id, season_year, is_current)
  VALUES (pg_temp.id('S1'), pg_temp.id('L1'), 9608, true), (pg_temp.id('S2'), pg_temp.id('L2'), 9608, true);
  INSERT INTO public.league_members(id, league_id, user_id, role, team_name)
  VALUES (pg_temp.id('A'), pg_temp.id('L1'), pg_temp.id('A'), 'commissioner', 'Trace A'),
    (pg_temp.id('B'), pg_temp.id('L1'), pg_temp.id('B'), 'manager', 'Trace B'),
    (pg_temp.id('C'), pg_temp.id('L2'), pg_temp.id('C'), 'commissioner', 'Trace C');
  INSERT INTO public.waiver_priorities(league_id, league_season_id, member_id, priority)
  VALUES (pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('A'), 1), (pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('B'), 2),
    (pg_temp.id('L2'), pg_temp.id('S2'), pg_temp.id('C'), 1)
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET priority = EXCLUDED.priority;
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
  VALUES (pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('A'), 5), (pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('B'), 5),
    (pg_temp.id('L2'), pg_temp.id('S2'), pg_temp.id('C'), 0)
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET balance = EXCLUDED.balance;
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, years_exp)
  SELECT pg_temp.id(player), 'Trace', player, 'PG', ARRAY['PG'], 3 FROM unnest(ARRAY['p1', 'p2', 'p3', 'p4', 'pd']) player;
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
  VALUES (pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('A'), pg_temp.id('pd'), 'draft');
  INSERT INTO public.waiver_claims(id, league_id, league_season_id, member_id, player_id, drop_player_id, drop_roster_slot,
    priority_at_submission, process_date, bid_amount, claim_order)
  VALUES
    (pg_temp.id('c1'), pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('A'), pg_temp.id('p2'), pg_temp.id('pd'), 'active', 1, v_run1, 1, 1),
    (pg_temp.id('c2'), pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('A'), pg_temp.id('p1'), pg_temp.id('pd'), 'active', 1, v_run1, 1, 2),
    (pg_temp.id('c3'), pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('B'), pg_temp.id('p1'), NULL, NULL, 2, v_run1, 1, 1),
    (pg_temp.id('c4'), pg_temp.id('L1'), pg_temp.id('S1'), pg_temp.id('B'), pg_temp.id('p3'), NULL, NULL, 2, v_run1 + 1, 5, 2),
    (pg_temp.id('c5'), pg_temp.id('L2'), pg_temp.id('S2'), pg_temp.id('C'), pg_temp.id('p4'), NULL, NULL, 1, v_run1, 0, 1);
END;
$$;

BEGIN;
\ir rules-support.sql

\! PGAPPNAME=pancake-waiver-trace-holder psql "$SUPABASE_DB_URL" -XAtq -c "SELECT pg_advisory_lock(hashtext('00000000-0000-0000-0000-000000060801'), hashtext('00000000-0000-0000-0000-000000060821'))" -c "SELECT pg_sleep(60)" >/dev/null 2>&1 &

DO $$
DECLARE
  v_started timestamptz;
BEGIN
  FOR attempt IN 1..100 LOOP
    EXIT WHEN EXISTS (SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory' AND lock.granted AND activity.application_name = 'pancake-waiver-trace-holder');
    PERFORM pg_sleep(0.1);
    PERFORM pg_stat_clear_snapshot();
  END LOOP;
  PERFORM pg_temp.check_rules(EXISTS (SELECT 1 FROM pg_locks lock JOIN pg_stat_activity activity ON activity.pid = lock.pid
      WHERE lock.locktype = 'advisory' AND lock.granted AND activity.application_name = 'pancake-waiver-trace-holder'),
    'another session holds team A while the run starts');
  v_started := clock_timestamp();
  PERFORM pg_temp.check_rules(pg_temp.run_until_idle() = ARRAY['c5'], 'a busy head team defers its league while other leagues award');
  PERFORM pg_temp.check_rules(clock_timestamp() - v_started < interval '2 seconds',
    'the run never waits on a busy team lock; it must try-lock and defer');
  PERFORM pg_temp.check_rules(pg_temp.claim('c1') = 'pending' AND pg_temp.claim('c3') = 'pending' AND pg_temp.claim('c4') = 'pending',
    'no lower claim passes the busy head');
  PERFORM pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = 'pancake-waiver-trace-holder';
  FOR attempt IN 1..100 LOOP
    EXIT WHEN NOT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'pancake-waiver-trace-holder');
    PERFORM pg_sleep(0.1);
    PERFORM pg_stat_clear_snapshot();
  END LOOP;
END;
$$;

SAVEPOINT aborted_batch;
DO $$
BEGIN
  PERFORM pg_temp.check_rules(pg_temp.run_until_idle() = ARRAY['c1', 'c3'], 'the run awards the league head across all players by process_date, bid, rolling priority, then claim_order');
END;
$$;
ROLLBACK TO SAVEPOINT aborted_batch;
DO $$
BEGIN
  PERFORM pg_temp.check_rules((SELECT bool_and(status = 'pending') FROM public.waiver_claims WHERE league_id = pg_temp.id('L1')),
    'an aborted batch leaves every claim pending for the retry');
  PERFORM pg_temp.check_rules(pg_temp.faab('A') = 5 AND pg_temp.faab('B') = 5, 'an aborted batch spends no FAAB');
END;
$$;

DO $$
BEGIN
  PERFORM pg_temp.check_rules(pg_temp.run_until_idle() = ARRAY['c1', 'c3'],
    'the run awards the league head by process_date, bid, rolling priority, then claim_order, across players');
  PERFORM pg_temp.check_rules(pg_temp.owner('p2') = 'A' AND pg_temp.owner('pd') = 'none', 'the preferred claim wins with its drop');
  PERFORM pg_temp.check_rules(pg_temp.claim('c2') = 'cancelled', 'a claim that shares the used drop is cancelled');
  PERFORM pg_temp.check_rules(pg_temp.owner('p1') = 'B' AND pg_temp.claim('c3') = 'succeeded', 'the other team wins the shared player');
  PERFORM pg_temp.check_rules(pg_temp.claim('c4') = 'failed_priority' AND pg_temp.owner('p3') = 'none',
    'the newer run claim fails once earlier wins leave too little FAAB');
  PERFORM pg_temp.check_rules(pg_temp.faab('A') = 4 AND pg_temp.faab('B') = 4, 'FAAB is spent only by awards');
  PERFORM pg_temp.check_rules(pg_temp.run_until_idle() = ARRAY[]::text[] AND pg_temp.faab('B') = 4, 'a retry after the run awards and charges nothing');
END;
$$;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
SELECT pg_temp.cleanup();
