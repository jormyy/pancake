BEGIN;
\ir rules-support.sql
UPDATE public.nba_games SET status='Final' WHERE status='InProgress';

CREATE FUNCTION pg_temp.floor_league(p_year int, p_teams int, p_floor int, p_roster_size int DEFAULT 16)
RETURNS TABLE (league_id uuid, season_id uuid, member_ids uuid[], user_ids uuid[], week_number int, week_end date)
LANGUAGE plpgsql AS $$
DECLARE f record; v_end date := (now() AT TIME ZONE 'America/New_York')::date; i int;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(p_teams, p_year);
  UPDATE public.leagues SET roster_size=p_roster_size, timezone='Pacific/Kiritimati',
    trade_veto_mode='disabled', trade_veto_window_hours=0, allow_inactive_trades=true
   WHERE id=f.league_id;
  INSERT INTO private.league_roster_policies(league_id, weekly_roster_floor, auto_ir_all_members)
    VALUES(f.league_id, p_floor, true);
  UPDATE private.league_roster_policies SET floor_activated_at = now(), ir_activated_at = now()
   WHERE private.league_roster_policies.league_id = f.league_id;
  INSERT INTO private.screen_refresh_queue(league_id, league_season_id, averages_initialized, averages_scoring)
    SELECT f.league_id, f.season_id, true, league.scoring_settings
      FROM public.leagues league WHERE league.id = f.league_id
    ON CONFLICT (league_season_id) DO UPDATE
      SET averages_initialized = true, averages_scoring = EXCLUDED.averages_scoring;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
    VALUES(f.league_id, f.season_id, v_end);
  INSERT INTO public.faab_balances(league_id, league_season_id, member_id, balance)
    SELECT f.league_id, f.season_id, member_id, 100 FROM unnest(f.member_ids) member_id
    ON CONFLICT ON CONSTRAINT faab_balances_league_id_league_season_id_member_id_key DO UPDATE SET balance = 100;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(p_year, 1, v_end - 6, v_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
    DO UPDATE SET week_start=EXCLUDED.week_start, week_end=EXCLUDED.week_end;
  FOR i IN 1..(p_teams / 2) LOOP
    INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
      VALUES(f.league_id, f.season_id, 1, f.member_ids[i * 2 - 1], f.member_ids[i * 2]);
  END LOOP;
  league_id := f.league_id; season_id := f.season_id; member_ids := f.member_ids; user_ids := f.user_ids;
  week_number := 1; week_end := v_end;
  RETURN NEXT;
END;
$$;

CREATE FUNCTION pg_temp.floor_roster(p_league uuid, p_season uuid, p_member uuid, p_count int,
  p_location text DEFAULT 'active', p_injury text DEFAULT 'Healthy')
RETURNS uuid[] LANGUAGE plpgsql AS $$
DECLARE i int; v_player uuid; v_ids uuid[] := ARRAY[]::uuid[];
BEGIN
  FOR i IN 1..p_count LOOP
    v_player := gen_random_uuid();
    INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
      VALUES(v_player, v_player::text, 'Roster' || i, 'Test', 'PG', ARRAY['PG'], p_injury, 'ZZ');
    INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir, is_on_taxi)
      VALUES(p_league, p_season, p_member, v_player, 'draft', p_location = 'ir', p_location = 'taxi');
    v_ids := v_ids || v_player;
  END LOOP;
  RETURN v_ids;
END;
$$;

CREATE FUNCTION pg_temp.floor_free_agent(p_league uuid, p_season uuid, p_year int, p_name text, p_avg numeric,
  p_injury text DEFAULT NULL, p_id uuid DEFAULT NULL, p_team text DEFAULT 'ZZ')
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_player uuid := COALESCE(p_id, gen_random_uuid());
BEGIN
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, nba_team)
    VALUES(v_player, v_player::text, p_name, 'Test', 'PG', ARRAY['PG'], p_injury, p_team);
  INSERT INTO public.player_season_averages(league_id, league_season_id, season_year, player_id, averages, avg_fantasy_points, version)
    VALUES(p_league, p_season, p_year, v_player, '{}'::jsonb, p_avg, 1);
  RETURN v_player;
END;
$$;

CREATE FUNCTION pg_temp.floor_isolate(p_league uuid, p_season uuid, p_keep uuid[])
RETURNS void LANGUAGE sql AS $$
  INSERT INTO public.waiver_wire_log(league_id, league_season_id, player_id, clears_at)
  SELECT p_league, p_season, player.id, now() + interval '1 day'
    FROM public.players player
   WHERE NOT (player.id = ANY(p_keep))
     AND NOT EXISTS (
       SELECT 1 FROM public.roster_players roster
        WHERE roster.league_id = p_league
          AND roster.league_season_id = p_season
          AND roster.player_id = player.id
     )
$$;

CREATE FUNCTION pg_temp.floor_active(p_league uuid, p_season uuid, p_member uuid)
RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM public.roster_players
   WHERE league_id = p_league AND league_season_id = p_season AND member_id = p_member
     AND NOT is_on_ir AND NOT is_on_taxi
$$;

CREATE FUNCTION pg_temp.floor_hold_trade(p_league uuid, p_season uuid, p_proposer uuid, p_recipient uuid, p_incoming uuid, p_user uuid)
RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE v_trade uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  v_trade := public.propose_trade_atomic(
    p_league, p_season, p_proposer, p_recipient,
    '{}'::uuid[], ARRAY[p_incoming], '{}'::uuid[], '{}'::uuid[], NULL, NULL, 5, 0);
  RETURN v_trade;
END;
$$;

DO $$
DECLARE f record; p1 uuid; p2 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9901, 2, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9901, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9901, 'Second', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, 'control floor add reaches the floor');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = p1), 'control floor add awards the best free agent');
  PERFORM pg_temp.check_rules((SELECT count(*) = 1 FROM public.roster_transactions WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = p1 AND transaction_type = 'fa_add'), 'control floor add writes one fa_add');
  PERFORM pg_temp.check_rules((SELECT acquired_via = 'roster_floor' FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1] AND player_id = p1), 'control floor add uses roster_floor');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; v_ir uuid; p1 uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9902, 2, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_ir := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 1, 'ir', 'Healthy'))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9902, 'Unused', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = v_ir AND is_on_ir), 'control IR return activates the healthy player');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, 'control IR return reaches the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[1]), 'control IR return needs no free agent');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; v_in uuid; p1 uuid; p2 uuid; v_trade uuid; v_roster_before uuid[]; v_trade_before jsonb; v_parts_before jsonb; v_items_before jsonb; v_claims_before int;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9903, 3, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  v_in := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 1))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9903, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9903, 'Second', 30);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, v_in]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_in, f.user_ids[1]);
  SELECT array_agg(player_id ORDER BY player_id) INTO v_roster_before FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1];
  SELECT to_jsonb(t) INTO v_trade_before FROM public.trades t WHERE t.id = v_trade;
  SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) INTO v_parts_before FROM public.trade_participants tp WHERE tp.trade_id = v_trade;
  SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) INTO v_items_before FROM public.trade_items ti WHERE ti.trade_id = v_trade;
  SELECT count(*) INTO v_claims_before FROM public.waiver_claims WHERE league_id = f.league_id AND member_id = f.member_ids[1];
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 15, 'hold blocks the floor add');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[3]) = 16, 'the control team still gets its add');
  PERFORM pg_temp.check_rules((SELECT array_agg(player_id ORDER BY player_id) FROM public.roster_players WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = v_roster_before, 'the holding roster is unchanged');
  PERFORM pg_temp.check_rules((SELECT to_jsonb(t) FROM public.trades t WHERE t.id = v_trade) = v_trade_before, 'the pending trade is unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) FROM public.trade_participants tp WHERE tp.trade_id = v_trade) = v_parts_before, 'every accepted_at is unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) FROM public.trade_items ti WHERE ti.trade_id = v_trade) = v_items_before, 'the trade items are unchanged');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM public.waiver_claims WHERE league_id = f.league_id AND member_id = f.member_ids[1]) = v_claims_before, 'the holding waiver claims are unchanged');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[1]), 'the hold leaves no award');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[3] AND player_id = p1), 'the control team gets the best free agent');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; v_in uuid; v_ir1 uuid; v_ir2 uuid; p1 uuid; v_trade uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9904, 3, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  v_in := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 1))[1];
  v_ir1 := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 1, 'ir', 'Healthy'))[1];
  v_ir2 := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 1, 'ir', 'Healthy'))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9904, 'Best', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, v_in]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_in, f.user_ids[1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND player_id = v_ir1), 'the hold keeps the healthy IR player on IR');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 15, 'the hold blocks the IR return');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = v_ir2 AND is_on_ir), 'the control IR player returns');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[3]) = 16, 'the control team reaches the floor');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[1]), 'the hold leaves no IR award');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; v_in uuid; p1 uuid; v_trade uuid; v_awards int; v_tx int; v_roster int; v_settlements jsonb; v_weeks jsonb; v_hold jsonb; v_conflict jsonb; v_parts_before jsonb; v_items_before jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9905, 3, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  v_in := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 1))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9905, 'Best', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, v_in]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_in, f.user_ids[1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  SELECT count(*) INTO v_awards FROM private.roster_floor_awards WHERE league_id = f.league_id;
  SELECT count(*) INTO v_tx FROM public.roster_transactions WHERE league_id = f.league_id;
  SELECT count(*) INTO v_roster FROM public.roster_players WHERE league_id = f.league_id;
  SELECT jsonb_agg(to_jsonb(s) ORDER BY s.process_date) INTO v_settlements FROM private.waiver_run_settlements s WHERE s.league_id = f.league_id;
  SELECT jsonb_agg(to_jsonb(w) ORDER BY w.week_number) INTO v_weeks FROM private.roster_floor_weeks w WHERE w.league_id = f.league_id;
  v_hold := public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1]);
  v_conflict := private.trade_hold_conflicts(f.league_id, f.season_id, f.member_ids[1], NULL, 'add', NULL, false, NULL, NULL);
  SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) INTO v_parts_before FROM public.trade_participants tp WHERE tp.trade_id = v_trade;
  SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) INTO v_items_before FROM public.trade_items ti WHERE ti.trade_id = v_trade;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules((SELECT count(*) FROM private.roster_floor_awards WHERE league_id = f.league_id) = v_awards, 'a second floor run awards nothing new');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM public.roster_transactions WHERE league_id = f.league_id) = v_tx, 'a second floor run writes no transactions');
  PERFORM pg_temp.check_rules((SELECT count(*) FROM public.roster_players WHERE league_id = f.league_id) = v_roster, 'a second floor run changes no roster');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.process_date) FROM private.waiver_run_settlements s WHERE s.league_id = f.league_id) = v_settlements, 'the settlements are unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(w) ORDER BY w.week_number) FROM private.roster_floor_weeks w WHERE w.league_id = f.league_id) = v_weeks, 'the floor weeks are unchanged');
  PERFORM pg_temp.check_rules((SELECT status = 'pending' FROM public.trades WHERE id = v_trade), 'the pending trade stays pending');
  PERFORM pg_temp.check_rules(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1]) = v_hold, 'the hold check is unchanged');
  PERFORM pg_temp.check_rules(private.trade_hold_conflicts(f.league_id, f.season_id, f.member_ids[1], NULL, 'add', NULL, false, NULL, NULL) = v_conflict, 'the hold conflicts are unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) FROM public.trade_participants tp WHERE tp.trade_id = v_trade) = v_parts_before, 'the participants are unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) FROM public.trade_items ti WHERE ti.trade_id = v_trade) = v_items_before, 'the items are unchanged');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; v_in uuid; v_ir uuid; p1 uuid; v_trade uuid; v_end date;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9906, 3, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  v_ir := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 1, 'ir', 'Healthy'))[1];
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 16);
  v_in := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 1))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9906, 'Best', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, v_in]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_in, f.user_ids[1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 15, 'the hold blocks the first week');
  PERFORM public.retract_trade_acceptance_atomic(v_trade, f.member_ids[1], f.user_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0, 'the withdrawal releases the hold');
  v_end := (now() AT TIME ZONE 'America/New_York')::date;
  UPDATE public.season_weeks SET week_end = v_end - 7 WHERE season_year = 9906 AND week_number = 1;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9906, 2, v_end - 6, v_end)
    ON CONFLICT ON CONSTRAINT season_weeks_season_year_week_number_key
    DO UPDATE SET week_start = EXCLUDED.week_start, week_end = EXCLUDED.week_end;
  INSERT INTO private.waiver_run_settlements(league_id, league_season_id, process_date)
    VALUES(f.league_id, f.season_id, v_end)
    ON CONFLICT DO NOTHING;
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id)
    VALUES(f.league_id, f.season_id, 2, f.member_ids[1], f.member_ids[2]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, 'the later week fills the team normally');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = v_ir AND is_on_ir), 'the later week returns the healthy IR player');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; y uuid; x uuid; p1 uuid; p2 uuid; p3 uuid;
BEGIN
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  SELECT * INTO f FROM pg_temp.floor_league(9908, 3, 16, 16);
  UPDATE public.leagues SET ir_slots = 1 WHERE id = f.league_id;
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  y := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(y, y::text, 'Injured', 'Starter', 'PG', ARRAY['PG'], 'Out', (f.week_end + 14)::text, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], y, 'draft');
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[1], y, 1, f.week_end, 'PG', false);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  x := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(x, x::text, 'Traded', 'Injured', 'PG', ARRAY['PG'], 'Out', (f.week_end + 30)::text, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES(f.league_id, f.season_id, f.member_ids[2], x, 'draft', true);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9908, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9908, 'Second', 30);
  p3 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9908, 'Third', 20);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, p3, x]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules((SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND player_id = y), 'control designation fills the open IR slot');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.weekly_lineups WHERE league_id = f.league_id AND player_id = y), 'control designated starter leaves the lineup');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, 'control designating team reaches the floor');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[3]) = 16, 'control other team reaches the floor');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

DO $$
DECLARE f record; y uuid; x uuid; p1 uuid; p2 uuid; p3 uuid; v_trade uuid; v_parts_before jsonb; v_items_before jsonb;
BEGIN
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
  SELECT * INTO f FROM pg_temp.floor_league(9909, 3, 16, 16);
  UPDATE public.leagues SET ir_slots = 1 WHERE id = f.league_id;
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 14);
  y := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(y, y::text, 'Injured', 'Starter', 'PG', ARRAY['PG'], 'Out', (f.week_end + 14)::text, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], y, 'draft');
  INSERT INTO public.weekly_lineups(league_id, league_season_id, member_id, player_id, week_number, game_date, slot_type, is_auto_set)
    VALUES(f.league_id, f.season_id, f.member_ids[1], y, 1, f.week_end, 'PG', false);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  x := gen_random_uuid();
  INSERT INTO public.players(id, sportsdata_id, first_name, last_name, position, eligible_positions, injury_status, injury_expected_return, nba_team)
    VALUES(x, x::text, 'Traded', 'Injured', 'PG', ARRAY['PG'], 'Out', (f.week_end + 30)::text, 'ZZ');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via, is_on_ir)
    VALUES(f.league_id, f.season_id, f.member_ids[2], x, 'draft', true);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[3], 15);
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9909, 'Best', 40);
  p2 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9909, 'Second', 30);
  p3 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9909, 'Third', 20);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, p2, p3, x]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], x, f.user_ids[1]);
  PERFORM public.set_trade_roster_plan_atomic(v_trade, f.member_ids[1], f.user_ids[1], '{}'::uuid[], ARRAY[x], '{}'::uuid[], '[]'::jsonb);
  PERFORM pg_temp.check_rules(jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0, 'the IR-reserving trade fits before the floor run');
  PERFORM pg_temp.check_rules((SELECT to_ir FROM public.trade_items WHERE trade_id = v_trade AND player_id = x), 'the trade reserves the last IR slot');
  SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) INTO v_parts_before FROM public.trade_participants tp WHERE tp.trade_id = v_trade;
  SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) INTO v_items_before FROM public.trade_items ti WHERE ti.trade_id = v_trade;
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(NOT (SELECT is_on_ir FROM public.roster_players WHERE league_id = f.league_id AND player_id = y), 'the reserved IR slot blocks the designation');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.weekly_lineups WHERE league_id = f.league_id AND player_id = y AND slot_type = 'PG' AND NOT is_auto_set), 'the manual starter stays put');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[3]) = 16, 'the other team completes its floor add');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.roster_floor_awards WHERE league_id = f.league_id AND member_id = f.member_ids[3]), 'the other team keeps its award');
  PERFORM pg_temp.check_rules(pg_temp.floor_active(f.league_id, f.season_id, f.member_ids[1]) = 16, 'the holding team still fills its open active spot');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.trade_roster_hold_check(f.member_ids[1], f.user_ids[1])) = 0, 'the IR reservation stays valid');
  PERFORM pg_temp.check_rules((SELECT status = 'pending' FROM public.trades WHERE id = v_trade), 'the IR-reserving trade stays pending');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(tp) ORDER BY tp.member_id) FROM public.trade_participants tp WHERE tp.trade_id = v_trade) = v_parts_before, 'the IR-reserving acceptances are unchanged');
  PERFORM pg_temp.check_rules((SELECT jsonb_agg(to_jsonb(ti) ORDER BY ti.id) FROM public.trade_items ti WHERE ti.trade_id = v_trade) = v_items_before, 'the IR-reserving items are unchanged');
  PERFORM pg_temp.check_rules((SELECT status = 'completed' FROM private.roster_floor_weeks WHERE league_id = f.league_id), 'the floor week completes');
  EXECUTE 'SET CONSTRAINTS ALL DEFERRED';
END $$;

SAVEPOINT negative_hold;
ALTER TABLE public.roster_players DISABLE TRIGGER lock_accepted_trade_capacity;
ALTER TABLE public.roster_players DISABLE TRIGGER check_accepted_trade_capacity;
CREATE OR REPLACE FUNCTION private.assert_accepted_trade_capacity(p_league_id uuid, p_season_id uuid, p_member_id uuid, p_include_trade_id uuid DEFAULT NULL)
RETURNS void LANGUAGE plpgsql AS $$ BEGIN END; $$;

DO $$
DECLARE f record; v_in uuid; v_ir uuid; p1 uuid; v_trade uuid;
BEGIN
  SELECT * INTO f FROM pg_temp.floor_league(9907, 2, 16, 16);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 15);
  PERFORM pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 16);
  v_in := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[2], 1))[1];
  v_ir := (pg_temp.floor_roster(f.league_id, f.season_id, f.member_ids[1], 1, 'ir', 'Healthy'))[1];
  p1 := pg_temp.floor_free_agent(f.league_id, f.season_id, 9907, 'Best', 40);
  PERFORM pg_temp.floor_isolate(f.league_id, f.season_id, ARRAY[p1, v_in]);
  v_trade := pg_temp.floor_hold_trade(f.league_id, f.season_id, f.member_ids[1], f.member_ids[2], v_in, f.user_ids[1]);
  PERFORM public.process_roster_floor_service(f.league_id, f.season_id);
  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.roster_players WHERE league_id = f.league_id AND player_id = v_ir AND is_on_ir), 'the held player returns when the hold guard is disabled');
END $$;
ROLLBACK TO SAVEPOINT negative_hold;
SET CONSTRAINTS ALL DEFERRED;

SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
