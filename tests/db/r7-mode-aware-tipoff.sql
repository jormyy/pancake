\set ON_ERROR_STOP on
\ir rules-support.sql
BEGIN;
DO $$
DECLARE f record; v_today date := (now() AT TIME ZONE 'America/New_York')::date;
  v_tipoff timestamptz := now() + interval '110 seconds';
  v_before text; v_after text; v_token uuid; v_next_token uuid; v_date date;
  v_work private.work_items%ROWTYPE; v_state text; v_count int; v_slot text;
  v_manual_player uuid; v_optin_player uuid; v_manual2_player uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(3, 9971);
  UPDATE public.leagues SET roster_size=20, ir_slots=1, timezone='Pacific/Kiritimati', scoring_settings='{"points":1}' WHERE id=f.league_id;
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL WHERE league_id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members, floor_activated_at, ir_activated_at)
    VALUES(f.league_id, 16, true, now(), now());
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9971, 1, v_today - 6, v_today)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key DO UPDATE SET week_end=EXCLUDED.week_end;
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, game_time, home_team, away_team, status)
    VALUES(gen_random_uuid(), '0029971001', 9971, 1, v_today, v_tipoff, 'ZZ', 'ZY', 'Scheduled');

  v_manual_player := gen_random_uuid();
  v_optin_player := gen_random_uuid();
  v_manual2_player := gen_random_uuid();
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, injury_status, nba_team) VALUES
    (v_manual_player, 'Manual', 'One', 'PG', ARRAY['PG'], NULL, 'ZZ'),
    (v_optin_player, 'Optin', 'Two', 'PG', ARRAY['PG'], NULL, 'ZZ'),
    (v_manual2_player, 'Manual', 'Three', 'PG', ARRAY['PG'], NULL, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via) VALUES
    (f.league_id, f.season_id, f.member_ids[1], v_manual_player, 'draft'),
    (f.league_id, f.season_id, f.member_ids[2], v_optin_player, 'draft'),
    (f.league_id, f.season_id, f.member_ids[3], v_manual2_player, 'draft');
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, slot_type, game_date, week_number, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[2], v_optin_player, 'PG', v_today, 1, false);

  DELETE FROM private.work_items;
  DELETE FROM public.lineup_tipoff_dispatches WHERE tipoff_at = v_tipoff;

  v_before := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy'
    AND payload->>'leagueId'=f.league_id::text AND payload->>'fingerprint'=v_before),
    'A: the manual member fingerprint enqueues the policy work');
  SELECT * INTO v_work FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(v_work.kind='pre-tipoff-policy', 'A: the policy work is claimed');

  v_token := gen_random_uuid();
  INSERT INTO public.lineup_tipoff_dispatches(tipoff_at, scope, game_date, token, status, lease_until, input_fingerprint, input_revision)
    VALUES(v_tipoff, f.league_id::text, v_today, v_token, 'queued', now() + interval '2 minutes', v_before, 0);
  v_date := public.claim_lineup_tipoff_dispatch(v_tipoff, v_token, f.league_id::text);
  PERFORM pg_temp.check_rules(v_date = v_today, 'A: the scoped dispatch is claimed');
  UPDATE public.lineup_tipoff_dispatches SET status='running', lease_until=now()+interval '1 minute'
   WHERE tipoff_at=v_tipoff AND scope=f.league_id::text;

  PERFORM public.mark_tipoff_ir_member_done(v_tipoff, v_token, f.league_id, f.season_id, f.member_ids[1], f.league_id::text);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_token, ARRAY[]::uuid[], 100, f.league_id::text)
    WHERE member_id=f.member_ids[1]), 'A: a manual member is not starter work before Auto Lineup is on');
  UPDATE public.lineup_tipoff_dispatches SET status='succeeded', finished_at=now()
   WHERE tipoff_at=v_tipoff AND scope=f.league_id::text;

  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
   WHERE league_id=f.league_id AND member_id=f.member_ids[1];
  v_after := private.pre_tipoff_policy_input_fingerprint(v_today, f.league_id);
  PERFORM pg_temp.check_rules(v_after IS DISTINCT FROM v_before,
    'B: enabling Auto Lineup changes the scoped fingerprint');

  PERFORM private.enqueue_pre_tipoff_optimizer(now());
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='pre-tipoff-policy'
    AND payload->>'leagueId'=f.league_id::text AND payload->>'fingerprint'=v_after),
    'B: the mode change enqueues new policy work');
  SELECT * INTO v_work FROM private.work_claim(1);
  PERFORM pg_temp.check_rules(v_work.kind='pre-tipoff-policy', 'B: the new policy work is claimed');

  v_next_token := gen_random_uuid();
  UPDATE public.lineup_tipoff_dispatches SET status='queued', token=v_next_token,
    input_revision=input_revision+1, input_fingerprint=v_after, lease_until=now()+interval '2 minutes'
   WHERE tipoff_at=v_tipoff AND scope=f.league_id::text;
  v_date := public.claim_lineup_tipoff_dispatch(v_tipoff, v_next_token, f.league_id::text);
  PERFORM pg_temp.check_rules(v_date = v_today, 'B: the new revision is claimed');
  UPDATE public.lineup_tipoff_dispatches SET status='running', lease_until=now()+interval '1 minute'
   WHERE tipoff_at=v_tipoff AND scope=f.league_id::text;

  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_next_token, ARRAY[]::uuid[], 100, f.league_id::text)
    WHERE member_id=f.member_ids[1]), 'B: the IR-only receipt no longer hides starter work');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.get_pending_auto_ir_members(v_today, v_tipoff, v_next_token, ARRAY[]::uuid[], 100, false, f.league_id::text)
    WHERE member_id=f.member_ids[1]), 'B: the enabled member leaves the IR-only list');

  PERFORM pg_temp.check_rules(public.apply_pre_tipoff_lineup(v_tipoff, v_next_token, f.league_id, f.season_id, f.member_ids[1],
    jsonb_build_array(jsonb_build_object('player_id', v_manual_player, 'slot_type', 'PG', 'is_auto_set', true,
      'week_number', 1, 'expected_active', true)), f.league_id::text),
    'B: the enabled member sets starters after the IR-only pass');
  SELECT count(*) INTO v_count FROM public.weekly_lineups
   WHERE league_id=f.league_id AND league_season_id=f.season_id AND member_id=f.member_ids[1] AND player_id=v_manual_player;
  PERFORM pg_temp.check_rules(v_count=1, 'B: the eligible unlocked starter is written');

  PERFORM pg_temp.check_rules(NOT public.apply_pre_tipoff_lineup(v_tipoff, v_next_token, f.league_id, f.season_id, f.member_ids[1],
    jsonb_build_array(jsonb_build_object('player_id', v_manual_player, 'slot_type', 'PG', 'is_auto_set', true,
      'week_number', 1, 'expected_active', true)), f.league_id::text),
    'C: a mode-unchanged retry is idempotent');
  SELECT count(*) INTO v_count FROM public.weekly_lineups
   WHERE league_id=f.league_id AND league_season_id=f.season_id AND member_id=f.member_ids[1] AND player_id=v_manual_player;
  PERFORM pg_temp.check_rules(v_count=1, 'C: the retry did not write a second starter');

  UPDATE public.lineup_optimizer_settings SET enabled=true, enabled_at=now()
   WHERE league_id=f.league_id AND member_id=f.member_ids[3];
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.get_pending_tipoff_members(v_tipoff, v_next_token, ARRAY[]::uuid[], 100, f.league_id::text)
    WHERE member_id=f.member_ids[3]), 'D: the member is pending starter work while enabled');
  UPDATE public.lineup_optimizer_settings SET enabled=false, enabled_at=NULL
   WHERE league_id=f.league_id AND member_id=f.member_ids[3];
  PERFORM pg_temp.check_rules(NOT public.apply_pre_tipoff_lineup(v_tipoff, v_next_token, f.league_id, f.season_id, f.member_ids[3],
    jsonb_build_array(jsonb_build_object('player_id', v_manual2_player, 'slot_type', 'PG', 'is_auto_set', true,
      'week_number', 1, 'expected_active', true)), f.league_id::text),
    'D: a member enabled at claim time but off before apply writes no starter');
  SELECT count(*) INTO v_count FROM public.weekly_lineups
   WHERE league_id=f.league_id AND league_season_id=f.season_id AND member_id=f.member_ids[3];
  PERFORM pg_temp.check_rules(v_count=0, 'D: the disabled member has no starter row');

  SELECT slot_type INTO v_slot FROM public.weekly_lineups
   WHERE league_id=f.league_id AND league_season_id=f.season_id AND member_id=f.member_ids[2] AND player_id=v_optin_player;
  PERFORM pg_temp.check_rules(v_slot='PG', 'E: the manual member slot is untouched');

  BEGIN
    PERFORM public.claim_lineup_tipoff_dispatch(v_tipoff, v_next_token);
  EXCEPTION WHEN OTHERS THEN
    v_state := SQLSTATE;
  END;
  PERFORM pg_temp.check_rules(v_state='PT409', 'F: an older worker cannot claim the scoped dispatch');

  RAISE NOTICE 'PASS r7-mode-aware-tipoff';
END;
$$;
ROLLBACK;
