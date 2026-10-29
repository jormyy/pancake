BEGIN;
SET LOCAL app.supabase_url = 'http://127.0.0.1:1';
SET LOCAL app.edge_internal_token = 'screen-refresh-fixture';
\ir rules-support.sql
DELETE FROM private.screen_refresh_queue;
DO $$
DECLARE f record; original bigint; newer bigint; name text; before_rows jsonb; after_rows jsonb; claim jsonb; result jsonb; refreshed boolean;
  player uuid := gen_random_uuid(); game uuid := gen_random_uuid(); matchup uuid := gen_random_uuid(); trade uuid := gen_random_uuid();
  table_name text; trade_values jsonb;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2, 9563);
  INSERT INTO public.players(id, first_name, last_name) VALUES(player, 'Refresh', 'Player');
  INSERT INTO public.nba_games(id, nba_game_id, season_year, week_number, game_date, home_team, away_team, status)
    VALUES(game, '002screen-refresh', 9563, 1, current_date, 'VST', 'OTH', 'Final');
  INSERT INTO public.player_game_stats(player_id, game_id, season_year, week_number, points, minutes_played)
    VALUES(player, game, 9563, 1, 17, 20);
  INSERT INTO public.matchups(id, league_id, league_season_id, week_number, home_member_id, away_member_id, home_points, away_points)
    VALUES(matchup, f.league_id, f.season_id, 1, f.member_ids[1], f.member_ids[2], 42, 31);
  INSERT INTO public.trades(id, league_id, league_season_id, proposer_member_id, recipient_member_id)
    VALUES(trade, f.league_id, f.season_id, f.member_ids[1], f.member_ids[2]);
  trade_values := jsonb_build_array(jsonb_build_object('tradeId', trade, 'revaluation', '{"analysis":{"teams":[]},"modelVersion":"fixture"}'::jsonb));
  SELECT version INTO original FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  FOREACH name IN ARRAY ARRAY['standings', 'matchup_totals', 'player_averages', 'trade_values'] LOOP
    EXECUTE format('SELECT private.refresh_%I($1,$2,$3)', name) USING f.league_id, f.season_id, original;
  END LOOP;
  PERFORM private.refresh_trade_values(f.league_id, f.season_id, original, trade_values);
  FOREACH table_name IN ARRAY ARRAY['standings_current','matchup_totals','player_season_averages','trade_value_cache'] LOOP
    EXECUTE format('UPDATE public.%I SET refreshed_at = now() - interval ''1 day'' WHERE league_season_id = $1', table_name) USING f.season_id;
  END LOOP;
  UPDATE public.trade_value_cache SET valid_until = now() + interval '7 minutes' WHERE league_season_id = f.season_id;
  FOREACH table_name IN ARRAY ARRAY['standings_current','matchup_totals','player_season_averages','trade_value_cache'] LOOP
    EXECUTE format('SELECT jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text) FROM public.%I row WHERE league_season_id = $1', table_name) INTO before_rows USING f.season_id;
    PERFORM pg_temp.check_rules(jsonb_array_length(before_rows) > 0, table_name || ' has a nonempty fixture');
    PERFORM private.refresh_standings(f.league_id, f.season_id, original);
    PERFORM private.refresh_matchup_totals(f.league_id, f.season_id, original);
    PERFORM private.refresh_player_averages(f.league_id, f.season_id, original);
    PERFORM private.refresh_trade_values(f.league_id, f.season_id, original, trade_values);
    EXECUTE format('SELECT jsonb_agg(to_jsonb(row) ORDER BY to_jsonb(row)::text) FROM public.%I row WHERE league_season_id = $1', table_name) INTO after_rows USING f.season_id;
    PERFORM pg_temp.check_rules(before_rows = after_rows, table_name || ' refresh is idempotent including timestamps');
  END LOOP;
  SELECT jsonb_agg(to_jsonb(row)) INTO before_rows FROM public.standings_current row WHERE league_season_id = f.season_id;
  PERFORM private.refresh_standings(f.league_id, f.season_id, original);
  SELECT jsonb_agg(to_jsonb(row)) INTO after_rows FROM public.standings_current row WHERE league_season_id = f.season_id;
  PERFORM pg_temp.check_rules(before_rows = after_rows, 'same version refresh leaves values and timestamps unchanged');
  UPDATE private.screen_refresh_queue SET dirty=false WHERE league_season_id=f.season_id;
  UPDATE public.league_members SET team_name = 'New name' WHERE id = f.member_ids[1];
  SELECT version INTO newer FROM private.screen_refresh_queue WHERE league_season_id = f.season_id;
  PERFORM pg_temp.check_rules(newer > original, 'member change advances version');
  PERFORM private.refresh_standings(f.league_id, f.season_id, newer);
  FOREACH name IN ARRAY ARRAY['standings', 'matchup_totals', 'player_averages', 'trade_values'] LOOP
    EXECUTE format('SELECT private.refresh_%I($1,$2,$3)', name) INTO refreshed USING f.league_id, f.season_id, original;
    PERFORM pg_temp.check_rules(NOT refreshed, name || ' refuses stale input');
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT team_name = 'New name' AND version = newer FROM public.standings_current WHERE member_id = f.member_ids[1]), 'stale work cannot overwrite newer row');
  UPDATE private.screen_refresh_queue SET dirty=false,claimed_at=NULL,claim_token=NULL,claimed_version=NULL
    WHERE league_season_id<>f.season_id;
  SELECT item INTO claim FROM jsonb_array_elements(public.view_refresh_work(p_params := '{"operation":"claim","limit":10}')) item
    WHERE item->>'seasonId' = f.season_id::text;
  PERFORM pg_temp.check_rules(claim->>'claimToken' IS NOT NULL, 'worker claims pending season');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.view_refresh_work()) item
    WHERE item->>'seasonId' = f.season_id::text), 'overlapping worker cannot claim active lease');
  UPDATE private.screen_refresh_queue SET changed_at=now()-interval '1 second' WHERE league_season_id=f.season_id;
  PERFORM private.refresh_queue_screen_views(f.league_id);
  result := public.view_refresh_work(f.league_id, NULL, claim || jsonb_build_object('operation', 'complete', 'tradeValues', trade_values));
  PERFORM pg_temp.check_rules(result = 'false', 'input change during work rejects publication');
  PERFORM pg_temp.check_rules((SELECT dirty AND claim_token IS NULL AND available_at>now() FROM private.screen_refresh_queue WHERE league_season_id = f.season_id), 'rejected work releases lease and keeps pending work');
  UPDATE private.screen_refresh_queue SET available_at=now() WHERE league_season_id=f.season_id;
  SELECT item INTO claim FROM jsonb_array_elements(public.view_refresh_work()) item WHERE item->>'seasonId' = f.season_id::text;
  PERFORM pg_temp.check_rules(public.view_refresh_work(f.league_id,NULL,claim||'{"operation":"complete","tradeValues":[]}')='false',
    'partial valuations cannot complete a season');
  PERFORM pg_temp.check_rules((SELECT dirty AND claim_token IS NULL FROM private.screen_refresh_queue WHERE league_season_id=f.season_id),
    'partial valuations leave retryable work');
  UPDATE private.screen_refresh_queue SET available_at=now() WHERE league_season_id=f.season_id;
  SELECT item INTO claim FROM jsonb_array_elements(public.view_refresh_work()) item WHERE item->>'seasonId'=f.season_id::text;
  result := public.view_refresh_work(f.league_id, NULL, claim || jsonb_build_object('operation', 'complete', 'tradeValues', trade_values));
  PERFORM pg_temp.check_rules(result = 'true', 'current worker publishes all four tables');
  PERFORM pg_temp.check_rules(public.view_refresh_work(f.league_id, NULL, claim || '{"operation":"complete"}') = 'false', 'duplicate completion cannot publish');
  PERFORM pg_temp.check_rules((SELECT NOT dirty FROM private.screen_refresh_queue WHERE league_season_id = f.season_id), 'successful refresh clears pending work');
  UPDATE public.leagues SET scoring_settings = '{"points":2}' WHERE id = f.league_id;
  PERFORM pg_temp.check_rules((SELECT dirty FROM private.screen_refresh_queue WHERE league_season_id = f.season_id), 'scoring changes queue work');
  UPDATE private.screen_refresh_queue SET claim_token = gen_random_uuid(), claimed_at = now() - interval '4 minutes' WHERE league_season_id = f.season_id;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM jsonb_array_elements(public.view_refresh_work()) item WHERE item->>'seasonId' = f.season_id::text), 'expired lease is reclaimable');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
