\set ON_ERROR_STOP on
BEGIN;
\ir ../../../tests/db/rules-support.sql
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='schedule-test';
DELETE FROM private.work_items;
DO $$
DECLARE tick timestamptz;
BEGIN
  FOREACH tick IN ARRAY ARRAY['9542-01-05 09:00 America/New_York'::timestamptz,
    '9542-01-05 10:00 America/New_York'::timestamptz,'9542-01-05 11:00 America/New_York'::timestamptz] LOOP
    PERFORM private.enqueue_player_injuries(tick);
    UPDATE private.work_items SET status='succeeded';
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=1 FROM private.work_items WHERE kind='player-injuries'),
    'off-day injuries run once daily');
END;
$$;
DELETE FROM private.work_items;
DO $$
DECLARE tick timestamptz;
BEGIN
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-schedule-injury',9542,1,'9542-01-06','9542-01-06 19:00 America/New_York','BOS','NYK','Scheduled');
  FOREACH tick IN ARRAY ARRAY['9542-01-06 16:00 America/New_York'::timestamptz,
    '9542-01-06 16:15 America/New_York'::timestamptz,'9542-01-06 16:30 America/New_York'::timestamptz,
    '9542-01-06 16:45 America/New_York'::timestamptz,'9542-01-06 17:00 America/New_York'::timestamptz,
    '9542-01-06 17:15 America/New_York'::timestamptz,'9542-01-06 17:30 America/New_York'::timestamptz,
    '9542-01-06 17:45 America/New_York'::timestamptz] LOOP
    PERFORM private.enqueue_player_injuries(tick);
    UPDATE private.work_items SET status='succeeded';
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM private.work_items WHERE kind='player-injuries'),
    'injuries switch from hourly to quarter-hour two hours before tipoff');
  PERFORM private.enqueue_player_injuries('9542-01-06 19:15 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=5 FROM private.work_items WHERE kind='player-injuries'),
    'injuries stop after the last tipoff');

END;
$$;
DELETE FROM private.work_items;
DO $$
DECLARE f record; game uuid:=gen_random_uuid(); matchup uuid:=gen_random_uuid(); player uuid:=gen_random_uuid();
  year integer:=extract(year FROM now())::integer; day date:=(now() AT TIME ZONE 'America/New_York')::date;
  claim record; screen jsonb; forecast jsonb:='{"modelVersion":"test","teams":[{},{}]}';
  version bigint; trade uuid; item private.work_items%ROWTYPE;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,year);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(year,49,day,day+6);
  INSERT INTO public.players(id,first_name,last_name,nba_team) VALUES(player,'Schedule','Player','BOS');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game,'002-schedule-live',year,49,day,now()-interval '1 hour','BOS','NYK','InProgress');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,49,f.member_ids[1],f.member_ids[2]);
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player,game,year,49,10,12);
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM analytics.player_season_totals WHERE player_id=player),
    'live stats do not rebuild season totals');
  UPDATE public.player_game_stats SET points=12 WHERE game_id=game AND player_id=player;
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM analytics.player_season_totals WHERE player_id=player),
    'another live tick leaves season totals untouched');
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,10);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'live forecast is claimable');
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),
    'live forecast publishes');
  UPDATE public.matchups SET home_points=12 WHERE id=matchup;
  PERFORM pg_temp.check_rules((SELECT due_at FROM private.matchup_forecast_schedule WHERE matchup_id=matchup)>=now()+interval '30 minutes',
    'score ticks wait thirty minutes after the previous forecast');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup),
    'another worker cannot recompute within thirty minutes');
  UPDATE public.matchup_forecasts SET calculated_at=now()-interval '31 minutes' WHERE matchup_id=matchup;
  UPDATE public.nba_games SET live_scoreboard_elapsed_seconds=2000 WHERE id=game;
  UPDATE private.forecast_refresh_requests SET available_at=now() WHERE matchup_id=matchup;
  UPDATE private.matchup_forecast_queue SET available_at=now() WHERE matchup_id=matchup;
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,10);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'elapsed game time triggers the next half-hour forecast');
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),
    'half-hour clock update publishes');
  UPDATE public.nba_games SET status='Final' WHERE id=game;
  PERFORM pg_temp.check_rules((SELECT points=12 AND games_played=1 FROM analytics.player_season_totals WHERE player_id=player),
    'game finalization publishes season totals once');
  UPDATE public.player_game_stats SET points=14 WHERE game_id=game AND player_id=player;
  PERFORM pg_temp.check_rules((SELECT points=14 AND games_played=1 FROM analytics.player_season_totals WHERE player_id=player),
    'final-stat corrections stay exact');
  PERFORM pg_temp.check_rules((SELECT due_at FROM private.matchup_forecast_schedule WHERE matchup_id=matchup) IS NULL,'forecasts stop outside games');
  UPDATE public.matchups SET is_finalized=true,winner_member_id=f.member_ids[1] WHERE id=matchup;
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,10);
  SELECT * INTO claim FROM public.claim_matchup_forecasts(25) WHERE matchup_id=matchup;
  PERFORM pg_temp.check_rules(claim.claim_token IS NOT NULL,'matchup end overrides the forecast interval');
  PERFORM pg_temp.check_rules(public.complete_matchup_forecast(matchup,claim.revision,claim.claim_token,forecast,now()+interval '1 hour'),
    'final forecast publishes');
  PERFORM pg_temp.check_rules((SELECT due_at FROM private.matchup_forecast_schedule WHERE matchup_id=matchup) IS NULL,'final forecast does not repeat');
  PERFORM pg_temp.check_rules((SELECT valid_until>now()+interval '1 year' FROM public.matchup_forecasts WHERE matchup_id=matchup),
    'final odds remain valid after background work stops');
  PERFORM private.complete_forecast_input_chunk() FROM generate_series(1,10);
  SELECT value INTO screen FROM jsonb_array_elements(public.view_refresh_work(p_params:='{"operation":"claim"}'))
    WHERE value->>'seasonId'=f.season_id::text;
  PERFORM pg_temp.check_rules(public.view_refresh_work(f.league_id,NULL,screen||'{"operation":"complete"}')='true',
    'saved screens publish the completed matchup');
  PERFORM pg_temp.check_rules((SELECT wins=1 FROM public.standings_current WHERE member_id=f.member_ids[1]),
    'standings publish after matchup end');
  PERFORM pg_temp.check_rules((SELECT (averages->>'avg_points')::numeric=14 FROM public.player_season_averages
    WHERE league_season_id=f.season_id AND player_id=player),'averages reflect the completed game');
  PERFORM private.refresh_queue_screen_views(f.league_id);
  PERFORM pg_temp.check_rules((SELECT available_at>=now()+interval '2 minutes' FROM private.screen_refresh_queue
    WHERE league_season_id=f.season_id),'repeated dirty screens coalesce for two minutes');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(public.view_refresh_work(p_params:='{"operation":"claim"}')) value
    WHERE value->>'seasonId'=f.season_id::text),'screens cannot be reclaimed early');
  INSERT INTO public.trades(league_id,league_season_id,proposer_member_id,recipient_member_id)
    VALUES(f.league_id,f.season_id,f.member_ids[1],f.member_ids[2]) RETURNING id INTO trade;
  SET CONSTRAINTS ALL IMMEDIATE;
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM public.trades WHERE id=trade AND status='pending'),
    'trade offer is visible immediately');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation' AND key=trade::text||':created'
    AND due_at<=now()),'new trade analysis queues immediately');
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'test'),'first trade analysis begins immediately');
  PERFORM pg_temp.check_rules(private.begin_trade_revaluation(trade,'test'),'failed analysis remains retryable');
  PERFORM private.refresh_trade_values(f.league_id,f.season_id,1,jsonb_build_array(jsonb_build_object(
    'tradeId',trade,'revaluation',jsonb_build_object('inputVersion',private.trade_revaluation_input_version(trade),'modelVersion','test'))));
  PERFORM pg_temp.check_rules(NOT private.begin_trade_revaluation(trade,'test'),'successful trade analysis waits overnight');
  PERFORM private.refresh_queue_trade_revaluation(trade,'changed','test');
  PERFORM pg_temp.check_rules((SELECT due_at>now() FROM private.work_items WHERE key=trade::text||':test:latest'),
    'changed trade inputs defer repeated analysis');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items WHERE kind='trade-revaluation-scan'),
    'screen refresh does not start trade scans');
  PERFORM pg_temp.check_rules(NOT has_table_privilege('authenticated','private.matchup_forecast_schedule','SELECT'),
    'forecast schedule is private');
END;
$$;
DO $$
DECLARE tick timestamptz; item private.work_items%ROWTYPE;
BEGIN
  DELETE FROM private.work_items;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(2027,48,'2026-10-26','2026-11-01') ON CONFLICT(season_year,week_number) DO NOTHING;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-schedule-projections',2027,48,'2026-10-26','2026-10-26 14:00 America/Los_Angeles','LAL','NYK','Scheduled');
  FOR tick IN SELECT generate_series('2026-10-26 00:00 America/Los_Angeles'::timestamptz,
    '2026-10-26 23:45 America/Los_Angeles'::timestamptz,interval '15 minutes') LOOP
    PERFORM private.enqueue_projection_sync(tick);
    UPDATE private.work_items SET status='succeeded';
  END LOOP;
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='pt:sleeper-day'),
    'Sleeper projections run once in the morning and once before the first game');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='pt:fantasypros'),
    'FantasyPros projections run once in the morning and once before the first game');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26 12:00 America/Los_Angeles')),
    'projections skip the old noon poll');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.projection_sync_due_work('2026-10-26 15:00 America/Los_Angeles')),
    'projections stop once games begin');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_rankings('2026-10-26 04:00 America/New_York');
  UPDATE private.work_items SET status='succeeded';
  PERFORM private.enqueue_rankings('2026-10-26 05:00 America/New_York');
  PERFORM private.enqueue_rankings('2026-10-26 12:00 America/New_York');
  PERFORM private.enqueue_rankings('2026-10-27 04:00 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=6 FROM private.work_items WHERE kind='sync-rankings'),
    'each ranking view runs once per night');
  DELETE FROM private.work_items;
  PERFORM private.enqueue_rankings('2026-11-01 03:59 America/New_York');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.work_items),'fall DST keeps nightly work before its local start');
  PERFORM private.enqueue_rankings('2026-11-01 04:00 America/New_York');
  PERFORM pg_temp.check_rules((SELECT count(*)=3 FROM private.work_items WHERE kind='sync-rankings'),
    'fall DST starts nightly work at four local');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('002-schedule-late-game',2027,1,current_date,now()-interval '1 hour','CHI','NYK','InProgress');
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
    VALUES('sync-rankings','test-defer','running',gen_random_uuid(),now()+interval '5 minutes','{}') RETURNING * INTO item;
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='pending' AND due_at>now() FROM private.work_items WHERE id=item.id),
    'late nightly work defers while games run');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),
    'deferred nightly work starts no edge worker');
  DELETE FROM private.work_items;
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
    VALUES('refresh-views','test-inline','running',gen_random_uuid(),now()+interval '5 minutes','{}') RETURNING * INTO item;
  UPDATE private.screen_refresh_queue SET available_at=now()-interval '1 minute',dirty=true;
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM private.work_items WHERE id=item.id),
    'screen work completes in the dispatcher database session');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),
    'screen work starts no separate edge worker');
  INSERT INTO private.work_items(kind,key,status,lease_token,lease_until,payload)
    VALUES('forecast-inputs','test-inline-forecasts','running',gen_random_uuid(),now()+interval '5 minutes','{}') RETURNING * INTO item;
  PERFORM private.work_execute(item.id,item.lease_token);
  PERFORM pg_temp.check_rules((SELECT status='succeeded' FROM private.work_items WHERE id=item.id),
    'forecast input work completes in the dispatcher database session');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM public.edge_invocations WHERE work_item_id=item.id),
    'forecast inputs start no separate edge worker');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.matchups'::regclass
    AND tgname='queue_live_matchup_refresh'),'saved screens share one coalesced refresh path');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM cron.job WHERE jobname='io-hint-drain')
    AND EXISTS(SELECT 1 FROM cron.job WHERE jobname='work-dispatcher' AND schedule='* * * * *'),
    'one minute dispatcher also drains pending hints');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
