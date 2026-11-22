\set ON_ERROR_STOP on
\ir rules-support.sql
BEGIN;
DO $$
DECLARE
  f record;
  v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tip1 timestamptz := now() + interval '110 seconds';
  v_tip2 timestamptz := now() + interval '100 seconds';
  v_tip3 timestamptz := now() + interval '90 seconds';
  v_scoped1 uuid := gen_random_uuid();
  v_scoped2 uuid := gen_random_uuid();
  v_queued uuid := gen_random_uuid();
  v_shared1 uuid := gen_random_uuid();
  v_shared2 uuid := gen_random_uuid();
  v_p1 uuid := gen_random_uuid();
  v_p1_inj uuid := gen_random_uuid();
  v_p2 uuid := gen_random_uuid();
  v_p2_inj uuid := gen_random_uuid();
  v_p3 uuid := gen_random_uuid();
  v_p4 uuid := gen_random_uuid();
  v_n int;
  v_s text;
  v_b boolean;
  v_d date;
  v_j jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4, 9909);
  UPDATE public.leagues SET roster_size = 20, ir_slots = 1 WHERE id = f.league_id;
  UPDATE public.lineup_optimizer_settings SET enabled = true, enabled_at = now() WHERE league_id = f.league_id;
  UPDATE public.lineup_optimizer_settings SET enabled = false, enabled_at = NULL
   WHERE league_id = f.league_id AND member_id = f.member_ids[2];
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(f.league_id, 16, true, now(), now());
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9909, 1, v_today - 6, v_today)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end = EXCLUDED.week_end;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status) VALUES
    (gen_random_uuid(), '0029909001', 9909, 1, v_today, v_tip1, 'ZZ', 'ZY', 'Scheduled'),
    (gen_random_uuid(), '0029909002', 9909, 1, v_today, v_tip2, 'ZX', 'ZW', 'Scheduled'),
    (gen_random_uuid(), '0029909003', 9909, 1, v_today, v_tip3, 'ZV', 'ZU', 'Scheduled');
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team) VALUES
    (v_p1, 'R9', 'Starter', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ'),
    (v_p1_inj, 'R9', 'StarterInjured', 'PG', ARRAY['PG'], 'Out', (v_today + 30)::text, 'ZZ'),
    (v_p2, 'R9', 'IrHealthy', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ'),
    (v_p2_inj, 'R9', 'IrInjured', 'PG', ARRAY['PG'], 'Out', (v_today + 30)::text, 'ZZ'),
    (v_p3, 'R9', 'Shared', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ'),
    (v_p4, 'R9', 'Fence', 'PG', ARRAY['PG'], NULL, 'unknown', 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], v_p1, 'draft'),
    (f.league_id, f.season_id, f.member_ids[1], v_p1_inj, 'draft'),
    (f.league_id, f.season_id, f.member_ids[2], v_p2, 'draft'),
    (f.league_id, f.season_id, f.member_ids[2], v_p2_inj, 'draft'),
    (f.league_id, f.season_id, f.member_ids[3], v_p3, 'draft'),
    (f.league_id, f.season_id, f.member_ids[4], v_p4, 'draft');
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at IN (v_tip1, v_tip2, v_tip3);
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_fingerprint, input_revision) VALUES
    (v_tip1, f.league_id::text, v_today, v_scoped1, 'running', now() + interval '2 minutes', 'r9a', 0),
    (v_tip1, '', v_today, v_shared1, 'running', now() + interval '2 minutes', 'r9d', 0),
    (v_tip2, f.league_id::text, v_today, v_scoped2, 'running', now() + interval '2 minutes', 'r9b', 0),
    (v_tip2, '', v_today, v_shared2, 'running', now() + interval '2 minutes', 'r9e', 0),
    (v_tip3, f.league_id::text, v_today, v_queued, 'queued', now() + interval '2 minutes', 'r9c', 0);

  -- Active path: the scoped dispatch admits its enabled members and its IR-only member.
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip1, v_scoped1, ARRAY[]::uuid[], 100, f.league_id::text);
  PERFORM pg_temp.check_rules(v_n = 3, 'A: the active scoped dispatch lists its three enabled members');
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip1, v_shared1, ARRAY[]::uuid[], 100, '') WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_n = 0, 'A: the active shared dispatch excludes the policy league');
  SELECT count(*) INTO v_n FROM public.get_pending_auto_ir_members(v_today, v_tip1, v_scoped1, ARRAY[]::uuid[], 100, false, f.league_id::text);
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the active scoped dispatch lists its IR-only member');
  SELECT count(*) INTO v_n FROM public.get_pending_auto_ir_members(v_today, v_tip1, v_shared1, ARRAY[]::uuid[], 100, false, '') WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_n = 0, 'A: the active shared dispatch excludes the policy league IR');

  v_b := public.apply_pre_tipoff_lineup(v_tip1, v_scoped1, f.league_id, f.season_id, f.member_ids[1],
    jsonb_build_array(jsonb_build_object('player_id', v_p1, 'slot_type', 'PG', 'is_auto_set', true, 'week_number', 1, 'expected_active', true)),
    f.league_id::text);
  PERFORM pg_temp.check_rules(v_b, 'A: the active scoped apply writes the starter');
  SELECT count(*) INTO v_n FROM public.weekly_lineups WHERE member_id = f.member_ids[1] AND player_id = v_p1;
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the active scoped starter row exists');
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip1 AND scope = f.league_id::text AND member_id = f.member_ids[1] AND starter_done;
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the active scoped starter receipt exists');

  v_j := public.auto_manage_ir_tipoff_service(v_tip1, v_scoped1, f.league_id, f.season_id, f.member_ids[2], f.league_id::text);
  PERFORM pg_temp.check_rules(jsonb_array_length(v_j->'moves') = 1, 'A: the fenced IR path moves the injured member');
  SELECT count(*) INTO v_n FROM public.roster_players WHERE member_id = f.member_ids[2] AND player_id = v_p2_inj AND is_on_ir;
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the injured member is on IR');
  PERFORM public.mark_tipoff_ir_member_done(v_tip1, v_scoped1, f.league_id, f.season_id, f.member_ids[2], f.league_id::text);
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip1 AND scope = f.league_id::text AND member_id = f.member_ids[2] AND ir_done;
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the active scoped IR receipt exists');
  PERFORM public.record_pre_tipoff_lineup_failure(v_tip1, v_scoped1, f.league_id, f.season_id, f.member_ids[3], 'active failure', f.league_id::text);
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip1 AND scope = f.league_id::text AND member_id = f.member_ids[3] AND error = 'active failure';
  PERFORM pg_temp.check_rules(v_n = 1, 'A: the active scoped failure receipt exists');
  PERFORM public.finish_lineup_tipoff_dispatch(v_tip1, v_scoped1, NULL, f.league_id::text);
  SELECT status INTO v_s FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tip1 AND scope = f.league_id::text;
  PERFORM pg_temp.check_rules(v_s = 'succeeded', 'A: the active scoped dispatch succeeds');

  -- Select before deactivation, then deactivate, then attempt the write.
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_scoped2, ARRAY[]::uuid[], 100, f.league_id::text);
  PERFORM pg_temp.check_rules(v_n = 3, 'B: the scoped dispatch selects members before deactivation');
  UPDATE private.league_roster_policies SET ir_activated_at = NULL, floor_activated_at = NULL WHERE league_id = f.league_id;

  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_scoped2, ARRAY[]::uuid[], 100, f.league_id::text);
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the deactivated scoped dispatch lists no starter work');
  SELECT count(*) INTO v_n FROM public.get_pending_auto_ir_members(v_today, v_tip2, v_scoped2, ARRAY[]::uuid[], 100, false, f.league_id::text);
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the deactivated scoped dispatch lists no IR work');
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_shared2, ARRAY[]::uuid[], 100, '') WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_n = 3, 'B: the shared dispatch admits the deactivated league members');

  PERFORM pg_temp.reject_rules(
    format('SELECT public.apply_pre_tipoff_lineup(%L,%L,%L,%L,%L,%L,%L)', v_tip2, v_scoped2, f.league_id, f.season_id,
      f.member_ids[4], jsonb_build_array(jsonb_build_object('player_id', v_p4, 'slot_type', 'PG', 'is_auto_set', true,
        'week_number', 1, 'expected_active', true)), f.league_id::text),
    'Tipoff scope is no longer active.', 'B: the deactivated scoped apply is refused');
  SELECT count(*) INTO v_n FROM public.weekly_lineups WHERE member_id = f.member_ids[4] AND player_id = v_p4;
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the refused scoped apply writes no lineup row');
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip2 AND scope = f.league_id::text AND member_id = f.member_ids[4];
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the refused scoped apply writes no receipt');

  PERFORM pg_temp.reject_rules(
    format('SELECT public.auto_manage_ir_tipoff_service(%L,%L,%L,%L,%L,%L)', v_tip2, v_scoped2, f.league_id, f.season_id,
      f.member_ids[2], f.league_id::text),
    'Tipoff scope is no longer active.', 'B: the deactivated fenced IR path is refused');
  SELECT count(*) INTO v_n FROM public.roster_players WHERE member_id = f.member_ids[2] AND player_id = v_p2_inj AND is_on_ir;
  PERFORM pg_temp.check_rules(v_n = 1, 'B: the refused fenced IR path changes no IR state');

  PERFORM pg_temp.reject_rules(
    format('SELECT public.mark_tipoff_ir_member_done(%L,%L,%L,%L,%L,%L)', v_tip2, v_scoped2, f.league_id, f.season_id,
      f.member_ids[4], f.league_id::text),
    'Tipoff scope is no longer active.', 'B: the deactivated scoped IR receipt is refused');
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip2 AND scope = f.league_id::text AND member_id = f.member_ids[4];
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the refused scoped IR receipt writes nothing');

  PERFORM pg_temp.reject_rules(
    format('SELECT public.record_pre_tipoff_lineup_failure(%L,%L,%L,%L,%L,%L,%L)', v_tip2, v_scoped2, f.league_id, f.season_id,
      f.member_ids[4], 'stale failure', f.league_id::text),
    'Tipoff scope is no longer active.', 'B: the deactivated scoped failure receipt is refused');
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip2 AND scope = f.league_id::text AND member_id = f.member_ids[4];
  PERFORM pg_temp.check_rules(v_n = 0, 'B: the refused scoped failure receipt writes nothing');

  PERFORM public.finish_lineup_tipoff_dispatch(v_tip2, v_scoped2, NULL, f.league_id::text);
  SELECT status INTO v_s FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tip2 AND scope = f.league_id::text;
  PERFORM pg_temp.check_rules(v_s = 'failed', 'B: the deactivated scoped dispatch finishes without success');

  v_d := public.claim_lineup_tipoff_dispatch(v_tip3, v_queued, f.league_id::text);
  PERFORM pg_temp.check_rules(v_d IS NULL, 'B: the deactivated queued scoped dispatch is not claimed');
  SELECT status INTO v_s FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tip3 AND scope = f.league_id::text;
  PERFORM pg_temp.check_rules(v_s = 'failed', 'B: the deactivated queued scoped dispatch ends without success');

  -- The shared worker still acts for the deactivated league's members.
  v_b := public.apply_pre_tipoff_lineup(v_tip2, v_shared2, f.league_id, f.season_id, f.member_ids[4],
    jsonb_build_array(jsonb_build_object('player_id', v_p4, 'slot_type', 'PG', 'is_auto_set', true, 'week_number', 1, 'expected_active', true)),
    '');
  PERFORM pg_temp.check_rules(v_b, 'C: the shared apply writes for the deactivated league');
  SELECT count(*) INTO v_n FROM public.weekly_lineups WHERE member_id = f.member_ids[4] AND player_id = v_p4;
  PERFORM pg_temp.check_rules(v_n = 1, 'C: the shared starter row exists');
  SELECT count(*) INTO v_n FROM public.lineup_tipoff_members
   WHERE tipoff_at = v_tip2 AND scope = '' AND member_id = f.member_ids[4] AND starter_done;
  PERFORM pg_temp.check_rules(v_n = 1, 'C: the shared starter receipt exists');
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_shared2, ARRAY[]::uuid[], 100, '') WHERE member_id = f.member_ids[4];
  PERFORM pg_temp.check_rules(v_n = 0, 'C: the shared member drops out after its receipt');

  -- Activation direction: a shared write for a league that became active skips without spinning.
  UPDATE private.league_roster_policies SET ir_activated_at = now(), floor_activated_at = now() WHERE league_id = f.league_id;
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_shared2, ARRAY[]::uuid[], 100, '') WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_n = 0, 'D: the reactivated league leaves the shared selection');
  v_b := public.apply_pre_tipoff_lineup(v_tip2, v_shared2, f.league_id, f.season_id, f.member_ids[1],
    jsonb_build_array(jsonb_build_object('player_id', v_p1, 'slot_type', 'PG', 'is_auto_set', true, 'week_number', 1, 'expected_active', true)),
    '');
  PERFORM pg_temp.check_rules(NOT v_b, 'D: the shared apply skips a reactivated league');
  SELECT count(*) INTO v_n FROM public.get_pending_tipoff_members(v_tip2, v_shared2, ARRAY[]::uuid[], 100, '') WHERE league_id = f.league_id;
  PERFORM pg_temp.check_rules(v_n = 0, 'D: the skipped shared member does not spin');
  PERFORM public.finish_lineup_tipoff_dispatch(v_tip2, v_shared2, NULL, '');
  SELECT status INTO v_s FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tip2 AND scope = '';
  PERFORM pg_temp.check_rules(v_s = 'succeeded', 'D: the shared dispatch still succeeds');

  RAISE NOTICE 'PASS r9-tipoff-deactivation-fence';
END;
$$;
ROLLBACK;
