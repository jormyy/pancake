BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
SET LOCAL app.edge_internal_token = 'screen-view-fixture';
\ir rules-support.sql
CREATE TEMP TABLE view_fixture AS SELECT fixture.*, gen_random_uuid() AS player_id, gen_random_uuid() AS other_player_id,
  gen_random_uuid() AS matchup_id, gen_random_uuid() AS draft_id, gen_random_uuid() AS trade_id
  FROM pg_temp.rules_fixture(3, 9562) fixture;
CREATE TEMP TABLE view_measurements(screen text, fields integer, milliseconds numeric, bytes integer);
GRANT SELECT ON view_fixture TO authenticated;
GRANT INSERT ON view_measurements TO authenticated;
DO $$
DECLARE f record; revision bigint; result jsonb;
BEGIN
  SELECT * INTO f FROM view_fixture;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  PERFORM pg_temp.check_rules(public.view_home(f.league_id, f.member_ids[1])->'matchup' = 'null', 'empty league has no matchup');
  PERFORM pg_temp.check_rules(public.view_roster(f.league_id, f.member_ids[1])->'roster' = '[]', 'empty league has no roster');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_standings(f.league_id, f.member_ids[1])->'standings') = 3, 'empty standings include every member');
  UPDATE public.league_members SET team_name = CASE id WHEN f.member_ids[1] THEN 'Zebra' WHEN f.member_ids[2] THEN 'éclair' ELSE 'alpha' END
    WHERE league_id = f.league_id;
  result := public.view_standings(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(result->'standings'->0->>'teamName' = 'alpha' AND result->'standings'->1->>'teamName' = 'éclair', 'standings use the client locale order for tied names');
  UPDATE public.league_members SET team_name = 'Rules team ' || array_position(f.member_ids, id) WHERE league_id = f.league_id;
  INSERT INTO public.season_weeks(season_year, week_number, week_start, week_end)
    VALUES(9562, 1, (now() AT TIME ZONE 'America/Los_Angeles')::date, (now() AT TIME ZONE 'America/Los_Angeles')::date + 6),
      (9562, 2, (now() AT TIME ZONE 'America/Los_Angeles')::date + 7, (now() AT TIME ZONE 'America/Los_Angeles')::date + 13);
  INSERT INTO public.players(id, first_name, last_name, position, eligible_positions, nba_team)
    VALUES(f.player_id, 'Screen', 'Starter', 'PG', ARRAY['PG'], 'VST'), (f.other_player_id, 'Screen', 'Free', 'C', ARRAY['C'], 'OTH');
  INSERT INTO public.roster_players(league_id, league_season_id, member_id, player_id, acquired_via)
    VALUES(f.league_id, f.season_id, f.member_ids[1], f.player_id, 'draft');
  INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES('002screen-parity', 9562, 1, (now() AT TIME ZONE 'America/Los_Angeles')::date, 'VST', 'OTH', 'InProgress');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, points, rebounds, assists, minutes_played)
    SELECT f.player_id, id, 9562, 1, 21, 9, 7, 24.5 FROM public.nba_games WHERE nba_game_id = '002screen-parity';
  INSERT INTO public.matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, home_points, away_points,
    home_max_possible_points, away_max_possible_points, is_finalized, winner_member_id)
    VALUES(f.matchup_id, f.league_id, f.season_id, 1, f.member_ids[1], f.member_ids[2], 100.25, 90.5, 120, 110, true, f.member_ids[1]);
  INSERT INTO public.matchups(league_id, league_season_id, week_number, home_member_id, away_member_id, home_points, away_points, is_finalized)
    VALUES(f.league_id, f.season_id, 2, f.member_ids[1], f.member_ids[3], 45, 55, false);
  INSERT INTO public.drafts(id, league_id, league_season_id, draft_type, is_mock, created_by_member_id)
    VALUES(f.draft_id, f.league_id, f.season_id, 'auction', true, f.member_ids[1]);
  INSERT INTO public.waiver_claims(league_id, league_season_id, member_id, player_id, priority_at_submission, process_date, bid_amount)
    VALUES(f.league_id, f.season_id, f.member_ids[1], f.other_player_id, 1, current_date + 1, 13),
      (f.league_id, f.season_id, f.member_ids[2], f.other_player_id, 2, current_date + 1, 97);
  INSERT INTO public.trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id)
    VALUES(f.trade_id, f.league_id, f.season_id, f.member_ids[1], f.member_ids[2]);
  INSERT INTO public.trade_participants(trade_id, member_id, sort_order, is_initiator, accepted_at)
    VALUES(f.trade_id, f.member_ids[1], 0, true, now()), (f.trade_id, f.member_ids[2], 1, false, NULL);
  INSERT INTO public.trade_items(trade_id, side, player_id, from_member_id, to_member_id)
    VALUES(f.trade_id, 'proposer', f.player_id, f.member_ids[1], f.member_ids[2]);
  SELECT version INTO revision FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  PERFORM private.refresh_standings(f.league_id, f.season_id, revision);
  PERFORM private.refresh_matchup_totals(f.league_id, f.season_id, revision);
  UPDATE public.nba_games SET status='Final' WHERE nba_game_id='002screen-parity';
  PERFORM private.refresh_player_averages(f.league_id, f.season_id, revision);
  PERFORM private.refresh_trade_values(f.league_id, f.season_id, revision,
    jsonb_build_array(jsonb_build_object('tradeId', f.trade_id, 'revaluation', '{"analysis":{"teams":[]}}'::jsonb)));
  UPDATE private.screen_refresh_queue SET dirty = false WHERE league_season_id = f.season_id;
  result := public.view_standings(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(result->'standings'->0 = jsonb_build_object('memberId', f.member_ids[1], 'teamName', 'Rules team 1',
    'wins', 1, 'losses', 0, 'ties', 0, 'pointsFor', 100.25, 'pointsAgainst', 90.5, 'maxPointsFor', 120), 'standings match hook fields exactly and exclude midweek points');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.matchups m JOIN public.matchup_totals t ON t.matchup_id = m.id
    WHERE m.league_id = f.league_id AND (m.home_points, m.away_points, m.home_max_possible_points, m.away_max_possible_points)
      IS DISTINCT FROM (t.home_points, t.away_points, t.home_max_possible_points, t.away_max_possible_points)), 'stored totals match all four existing total fields');
  PERFORM pg_temp.check_rules((SELECT cached.averages = to_jsonb(original) FROM public.player_season_averages cached
    JOIN public.mv_player_season_averages original USING(player_id, season_year) WHERE cached.league_id = f.league_id AND cached.player_id = f.player_id), 'stored averages match every original average field');
  PERFORM pg_temp.check_rules((SELECT cached.avg_fantasy_points IS NOT DISTINCT FROM original.avg_fantasy_points
    FROM public.player_season_averages cached JOIN public.v_player_avg_fantasy_points original USING(league_id, player_id, season_year)
    WHERE cached.league_id = f.league_id AND cached.player_id = f.player_id), 'stored fantasy average matches original read');
  UPDATE public.nba_games SET status='InProgress' WHERE nba_game_id='002screen-parity';
  UPDATE public.matchups SET matchup_type = 'playoff_final', home_points = 9999 WHERE id = f.matchup_id;
  SELECT version INTO revision FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  PERFORM private.refresh_standings(f.league_id, f.season_id, revision);
  result := public.view_standings(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'standings') row
    WHERE (row->>'wins')::integer <> 0 OR (row->>'pointsFor')::numeric <> 0), 'playoff totals do not enter regular season standings');
  UPDATE public.waiver_claims SET status = 'cancelled' WHERE league_season_id = f.season_id;
  UPDATE public.league_seasons SET is_current = false WHERE id = f.season_id;
  PERFORM pg_temp.check_rules(public.view_home(f.league_id, f.member_ids[1])->'matchup' = 'null', 'offseason has no current matchup');
  PERFORM pg_temp.check_rules(jsonb_array_length(public.view_roster(f.league_id, f.member_ids[1])->'roster') = 1, 'offseason keeps latest roster');
  PERFORM pg_temp.check_rules(public.view_claims(f.league_id, f.member_ids[1])->'claims' = '[]', 'offseason has no active claims');
  INSERT INTO public.nba_games(nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES('002screen-offseason', public.current_season_year_et(), 1, (now() AT TIME ZONE 'America/Los_Angeles')::date, 'VST', 'OTH', 'Final');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, points, minutes_played)
    SELECT f.player_id, id, public.current_season_year_et(), 1, 9, 12 FROM public.nba_games WHERE nba_game_id = '002screen-offseason';
  result := public.view_roster(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules((result->'avgStatsMap'->f.player_id::text->>'avg_points')::numeric = 9, 'offseason uses current NBA averages before league season rollover');
  DELETE FROM public.player_game_stats WHERE game_id IN (SELECT id FROM public.nba_games WHERE nba_game_id = '002screen-offseason');
  DELETE FROM public.nba_games WHERE nba_game_id = '002screen-offseason';
  UPDATE public.league_seasons SET is_current = true WHERE id = f.season_id;
  UPDATE public.waiver_claims SET status = 'pending' WHERE league_season_id = f.season_id;
  SELECT version INTO revision FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  PERFORM private.refresh_matchup_totals(f.league_id, f.season_id, revision);
END;
$$;
SET LOCAL ROLE authenticated;
DO $$
DECLARE f record; screen text; result jsonb; params jsonb; started timestamptz;
BEGIN
  SELECT * INTO f FROM view_fixture;
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[1]::text, true);
  params := jsonb_build_object('playerId', f.player_id, 'draftId', f.draft_id, 'tradeId', f.trade_id, 'seasonYear', 9562);
  FOREACH screen IN ARRAY ARRAY['home','roster','players','player','claims','claim_editor','lineup','standings','activity','picks','settings','league',
    'trades','trade_block','trade_details','trade_analysis','draft_rooms','draft_room','profile'] LOOP
    started := clock_timestamp();
    EXECUTE format('SELECT public.view_%I($1,$2,$3)', screen) INTO result USING f.league_id, f.member_ids[1], params;
    PERFORM pg_temp.check_rules(jsonb_typeof(result) = 'object', screen || ' reads as authenticated member');
    INSERT INTO view_measurements VALUES(screen, (SELECT count(*) FROM jsonb_object_keys(result)), extract(epoch FROM clock_timestamp() - started) * 1000, octet_length(result::text));
    PERFORM pg_temp.reject_rules(format('SELECT public.view_%I(%L,%L,%L)', screen, f.league_id, f.member_ids[2], params),
      'This screen is not available.', screen || ' rejects another member identity');
  END LOOP;
  result := public.view_claims(f.league_id, f.member_ids[1]);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'claims') = 1 AND (result->'claims'->0->>'bidAmount')::integer = 13, 'only own sealed bid is visible');
  result := public.view_home(f.league_id, f.member_ids[1], params);
  PERFORM pg_temp.check_rules((result->'liveStats'->f.player_id::text->>'points')::integer = 21, 'home includes displayed player live stats');
  PERFORM pg_temp.check_rules(result->'startedTeams' @> '["VST"]', 'home includes started game teams');
  result := public.view_player(f.league_id, f.member_ids[1], params);
  PERFORM pg_temp.check_rules((result->'gameLog'->0->>'points')::integer = 21 AND (result->>'includesLive')::boolean, 'player includes game log and live flag');
  result := public.view_profile(NULL, NULL);
  PERFORM pg_temp.check_rules(NOT (result->'profile' ?| ARRAY['push_token','push_token_revocation_hash']), 'profile excludes private token columns');
  result := public.view_trade_details(f.league_id, f.member_ids[1], params);
  PERFORM pg_temp.check_rules(result->'trade'->'routedItems'->0->>'playerId' = f.player_id::text, 'trade includes the selected player asset');
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'trade'->'participants') = 2, 'trade includes both participant records');
  result := public.view_trades(f.league_id, f.member_ids[1], params);
  PERFORM pg_temp.check_rules(jsonb_array_length(result->'trades') = 1, 'offers include the outgoing participant trade');
  PERFORM set_config('request.jwt.claim.sub', f.user_ids[3]::text, true);
  result := public.view_trade_details(f.league_id, f.member_ids[3], params);
  PERFORM pg_temp.check_rules(result->'trade' = 'null', 'uninvolved manager cannot read a private trade');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.trade_value_cache WHERE trade_id = f.trade_id), 'private cached analysis follows trade visibility');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated', 'public.view_refresh_work(uuid,uuid,jsonb)', 'EXECUTE'), 'client cannot publish cached work');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated', 'public.standings_current', 'UPDATE'), 'client cannot forge standings');
END;
$$;
RESET ROLE;
TABLE view_measurements;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
