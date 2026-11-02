BEGIN;
\ir rules-support.sql
CREATE OR REPLACE FUNCTION private.scheduler_health()
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path='' AS $$
  SELECT jsonb_build_object('available',true,'checked_at',clock_timestamp(),'samples',10,
    'success_ratio',0.7,'avg_duration_seconds',0.1,'startup_timeouts',0);
$$;
DO $$
DECLARE fixture record; matchup uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); player uuid:=gen_random_uuid();
  stat uuid; points numeric; today date:=(now() AT TIME ZONE 'America/New_York')::date; refreshed integer;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9630);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    VALUES(9630,1,today-1,today+5);
  UPDATE public.leagues SET scoring_settings='{"points":1}' WHERE id=fixture.league_id;
  INSERT INTO public.players(id,first_name,last_name,nba_team,nba_id,position)
    VALUES(player,'Shed','Scoring','BOS',player::text,'PG');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],player,'draft');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time,started_at)
    VALUES(game,'0029630001',9630,1,today,'BOS','NYK','InProgress',now()-interval '30 minutes',now()-interval '30 minutes');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(matchup,fixture.league_id,fixture.season_id,1,fixture.member_ids[1],fixture.member_ids[2],0,0);
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,week_number,game_date,slot_type)
    VALUES(fixture.league_id,fixture.season_id,fixture.member_ids[1],player,1,today,'PG');
  INSERT INTO public.matchup_totals(matchup_id,league_id,league_season_id,home_points,away_points,version)
    VALUES(matchup,fixture.league_id,fixture.season_id,0,0,1);
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played,did_not_play)
    VALUES(player,game,9630,1,25,12,false) RETURNING id INTO stat;
  SELECT public.compute_fantasy_points(stat,fixture.league_id) INTO points;
  PERFORM public.update_score_points_atomic(fixture.league_id,fixture.season_id,1,
    jsonb_build_array(jsonb_build_object('id',matchup,'home_points',points,'away_points',0)));
  PERFORM pg_temp.check_rules(points=25,'the stat line publishes 25 fantasy points');
  PERFORM pg_temp.check_rules((SELECT home_points=0 FROM public.matchup_totals WHERE matchup_id=matchup),
    'the cache awaits its essential refresh');
  PERFORM pg_temp.check_rules(NOT EXISTS(SELECT 1 FROM private.live_matchup_refresh_queue WHERE matchup_id=matchup),'ordinary saves do not recreate the retired per-tick queue');
  INSERT INTO private.live_matchup_refresh_queue(matchup_id) VALUES(matchup);
  DELETE FROM private.work_items;
  PERFORM private.work_enqueue('refresh-views','shed-heavy',now(),'{}',fixture.league_id);
  INSERT INTO private.work_items(kind,key,status,attempts,due_at,lease_token,lease_until,payload)
    SELECT 'player-injuries','shed-running-'||n,'running',1,now(),gen_random_uuid(),clock_timestamp()+interval '5 minutes',jsonb_build_object('slot',n)
    FROM generate_series(1,4) n;
  UPDATE private.worker_controls SET paused=false,scheduler_level='shed',scheduler_checked_at=NULL,scheduler_healthy_since=NULL WHERE id;
  SELECT public.dispatch_work() INTO refreshed;
  PERFORM pg_temp.check_rules((SELECT home_points=25 FROM public.matchup_totals WHERE matchup_id=matchup),
    'one shed dispatch refreshes live matchup totals despite four busy workers');
  PERFORM pg_temp.check_rules((SELECT scheduler_level='shed' FROM private.worker_controls WHERE id),'the watchdog remains in shed');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-live-matchups' AND status='succeeded'),
    'the essential refresh has a successful work receipt');
  PERFORM pg_temp.check_rules(EXISTS(SELECT 1 FROM private.work_items WHERE kind='refresh-views' AND status='pending'),
    'the heavy refresh can wait');
  UPDATE public.player_game_stats SET points=26 WHERE id=stat;
  SELECT public.compute_fantasy_points(stat,fixture.league_id) INTO points;
  PERFORM public.update_score_points_atomic(fixture.league_id,fixture.season_id,1,
    jsonb_build_array(jsonb_build_object('id',matchup,'home_points',points,'away_points',0)));
  INSERT INTO private.live_matchup_refresh_queue(matchup_id) VALUES(matchup);
  PERFORM public.dispatch_work();
  PERFORM pg_temp.check_rules((SELECT home_points=26 FROM public.matchup_totals WHERE matchup_id=matchup),
    'a second change in the same minute is not suppressed by the earlier receipt');
  PERFORM pg_temp.check_rules((SELECT count(*)=2 FROM private.work_items WHERE kind='refresh-live-matchups' AND status='succeeded'),
    'coalesced screen versions do not coalesce away live changes');
END;
$$;
DO $$
DECLARE fixture record; today date:=(now() AT TIME ZONE 'America/New_York')::date; count integer;
BEGIN
  SELECT * INTO fixture FROM pg_temp.rules_fixture(2,9631);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end)
    SELECT 9631,n,today-1,today+5 FROM generate_series(1,9) n;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,home_team,away_team,status,game_time)
    VALUES('0029631001',9631,1,today,'BOS','NYK','InProgress',now()-interval '30 minutes');
  INSERT INTO public.matchups(league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    SELECT fixture.league_id,fixture.season_id,n,fixture.member_ids[1],fixture.member_ids[2],n,0 FROM generate_series(1,9) n;
  INSERT INTO private.live_matchup_refresh_queue(matchup_id) SELECT id FROM public.matchups WHERE league_id=fixture.league_id;
  SELECT private.refresh_live_matchup_totals() INTO count;
  PERFORM pg_temp.check_rules(count=8,'one live refresh statement consumes at most eight pending matchups');
  PERFORM pg_temp.check_rules((SELECT count(*)=8 FROM public.matchup_totals WHERE league_id=fixture.league_id),
    'the ninth matchup waits for the next bounded statement');
  PERFORM private.refresh_live_matchup_totals();
  PERFORM pg_temp.check_rules((SELECT count(*)=9 FROM public.matchup_totals WHERE league_id=fixture.league_id),
    'a later bounded statement drains the remaining matchup');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
