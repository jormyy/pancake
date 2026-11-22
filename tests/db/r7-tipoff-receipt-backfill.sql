\set ON_ERROR_STOP on
\ir rules-support.sql
BEGIN;
CREATE TEMP TABLE backfill_fixture(
  league_id uuid, season_id uuid, member_done uuid, member_failed uuid,
  tipoff_at timestamptz, token uuid
);
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds'; v_token uuid := gen_random_uuid();
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9972);
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES(gen_random_uuid(), '0029972001', 9972, 1, v_today, v_tipoff, 'ZZ', 'ZY', 'Scheduled');
  INSERT INTO public.lineup_optimizer_settings(league_id, league_season_id, member_id, enabled, enabled_at) VALUES
    (f.league_id, f.season_id, f.member_ids[1], true, now()),
    (f.league_id, f.season_id, f.member_ids[2], true, now())
  ON CONFLICT (league_id, league_season_id, member_id) DO UPDATE SET enabled=true, enabled_at=now();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_revision)
    VALUES(v_tipoff, '', v_today, v_token, 'running', now() + interval '2 minutes', 0);
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision)
    VALUES(v_tipoff, '', f.league_id, f.season_id, f.member_ids[1], 0);
  INSERT INTO public.lineup_tipoff_members(tipoff_at, scope, league_id, league_season_id, member_id, input_revision, error)
    VALUES(v_tipoff, '', f.league_id, f.season_id, f.member_ids[2], 0, 'legacy failure');
  INSERT INTO backfill_fixture VALUES(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_tipoff, v_token);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='lineup_tipoff_members' AND column_name='starter_done'),
    'A: the legacy stack has no completion flags yet');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, '')
    WHERE member_id IN (f.member_ids[1], f.member_ids[2])), 'A: the legacy receipts are done before the migration');
END;
$$;
\ir ../../supabase/migrations/20261214011800_tipoff_mode_aware_completion.sql
\ir ../../supabase/migrations/20261214011800_tipoff_mode_aware_completion.sql
DO $$
DECLARE f backfill_fixture%ROWTYPE; v_done public.lineup_tipoff_members%ROWTYPE;
  v_failed public.lineup_tipoff_members%ROWTYPE;
BEGIN
  SELECT * INTO f FROM backfill_fixture;
  SELECT * INTO v_done FROM public.lineup_tipoff_members
   WHERE league_id=f.league_id AND member_id=f.member_done;
  SELECT * INTO v_failed FROM public.lineup_tipoff_members
   WHERE league_id=f.league_id AND member_id=f.member_failed;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(f.tipoff_at, f.token, ARRAY[]::uuid[], 100, '')
    WHERE member_id IN (f.member_done, f.member_failed)), 'C: neither legacy receipt is pending starter work');
  PERFORM pg_temp.check_rules(NOT public.apply_pre_tipoff_lineup(f.tipoff_at, f.token, f.league_id, f.season_id,
    f.member_done, '[]'::jsonb, ''), 'D: the legacy done member is not applied again');
  PERFORM pg_temp.check_rules(v_done.ir_done AND v_done.starter_done,
    'B: the legacy done receipt is complete in both modes');
  PERFORM pg_temp.check_rules(NOT v_failed.ir_done AND NOT v_failed.starter_done AND v_failed.error='legacy failure',
    'B: the legacy error receipt keeps its flags and error');
  PERFORM pg_temp.check_rules((SELECT game_date FROM public.lineup_tipoff_dispatches WHERE tipoff_at=f.tipoff_at)
    = (now() AT TIME ZONE 'America/New_York')::date, 'E: the dispatch window is still open');
  RAISE NOTICE 'PASS r7-tipoff-receipt-backfill';
END;
$$;
ROLLBACK;
