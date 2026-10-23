BEGIN;
CREATE TEMP TABLE sleeper_checks(label text PRIMARY KEY);
CREATE FUNCTION pg_temp.check_sleeper(ok boolean,label text) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'FAIL: %',label; END IF;
  INSERT INTO sleeper_checks VALUES(label);
END;
$$;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); custom uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); member uuid:=gen_random_uuid();
  p uuid:=gen_random_uuid(); fallback uuid:=gen_random_uuid(); run uuid:=gen_random_uuid(); second_run uuid:=gen_random_uuid();
  fp_daily uuid:=gen_random_uuid(); fp_week uuid:=gen_random_uuid(); fp_new uuid:=gen_random_uuid();
  d date:=(now() AT TIME ZONE 'America/New_York')::date; row_data jsonb; result record;
  original_id uuid; fingerprint text; before_hints jsonb; report jsonb;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test',jsonb_build_object('username',u::text));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings) VALUES
    (l,'Sleeper test',l::text,u,'active','{"points":1}'),
    (custom,'Sleeper makes',custom::text,u,'active','{"points":1,"field_goals_made":2,"field_goals_attempted":-1,"free_throws_made":3,"free_throws_attempted":-1}');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season,l,2098,true);
  INSERT INTO public.league_members(id,league_id,user_id,role) VALUES(member,l,u,'commissioner');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2098,1,d,d+6);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team) VALUES
    (p,'Sleeper','Primary','PG',ARRAY['PG'],'BOS'),(fallback,'Sleeper','Fallback','PG',ARRAY['PG'],'BOS');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(l,season,member,p,'draft');
  INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(l,season,member,true)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
    ('0029810001',2098,1,d,now()+interval '2 hours','BOS','DET','Scheduled'),
    ('0029810002',2098,1,d+1,now()+interval '26 hours','BOS','PHI','Scheduled');
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,projection_date,status,completed_at) VALUES
    (fp_daily,'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2098,1,d,'success',now()),
    (fp_week,'fantasypros','weekly_avg','https://www.fantasypros.com/nba/projections/avg-weekly-overall.php',2098,1,NULL,'success',now());
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,projection_date,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points,games_played)
  SELECT r.id,r.projection_type,r.source_url,ordinality,2098,1,r.projection_date,now(),'Sleeper test','sleeper test',player,'matched',10,2
    FROM public.projection_sync_runs r CROSS JOIN unnest(ARRAY[p,fallback]) WITH ORDINALITY AS players(player,ordinality)
    WHERE r.id IN(fp_daily,fp_week);
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number)
    VALUES(run,'sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1);
  row_data:=jsonb_build_object('player_id',p,'source_game_id','sleeper-test-1','sleeper_id','fixture-player','season_year',2098,'week_number',1,
    'game_date',d,'team','BOS','opponent','DET','points',20,'rebounds',0,'assists',0,'steals',0,'blocks',0,
    'three_pointers_made',0,'turnovers',0,'field_goals_made',8,'field_goals_attempted',15,
    'free_throws_made',2,'free_throws_attempted',3,'three_pointers_attempted',0,'minutes',30,'last_modified',1);
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(row_data),1,0,200);
  SELECT id INTO original_id FROM public.sleeper_projection_rows WHERE player_id=p;
  SELECT * INTO result FROM public.get_league_projection_rows(l,2098,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_source='sleeper' AND result.projection_points=20,'Sleeper beats FantasyPros today');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2098,d,'today',ARRAY[fallback],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_source='fantasypros_daily' AND result.projection_points=10,'missing Sleeper player uses FantasyPros today');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2098,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=30 AND result.projection_games_played=2,'week total fills missing game from FantasyPros');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2098,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=15 AND result.projection_fantasy_points=15,'week average includes missing-game fallback');
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_source='sleeper' AND result.projection_fantasy_points=24,'Sleeper scores makes and attempts through league settings');

  fingerprint:=private.pre_tipoff_input_fingerprint(d);
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number)
    VALUES(second_run,'sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1);
  PERFORM public.complete_sleeper_projection_sync(second_run,jsonb_build_array(row_data||'{"last_modified":2}'::jsonb),1,0,200);
  PERFORM pg_temp.check_sleeper(fingerprint=private.pre_tipoff_input_fingerprint(d),'unchanged pull preserves optimizer fingerprint');
  PERFORM pg_temp.check_sleeper((SELECT count(*)=1 AND min(id::text)=original_id::text FROM public.sleeper_projection_rows WHERE player_id=p),'second pull updates one player-game in place');
  UPDATE public.sleeper_projection_rows SET points=22 WHERE player_id=p;
  PERFORM pg_temp.check_sleeper(fingerprint<>private.pre_tipoff_input_fingerprint(d),'changed scored input wakes optimizer');
  row_data:=row_data||jsonb_build_object('source_game_id','sleeper-test-2','game_date',d+1,'opponent','PHI','points',30,
    'field_goals_made',10,'field_goals_attempted',20,'free_throws_made',3,'free_throws_attempted',4,'last_modified',3);
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1) RETURNING id INTO run;
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(row_data),1,0,200);
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_fantasy_points=61 AND result.projection_points=52,'week total sums each game with custom scoring');
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_fantasy_points=30.5 AND result.projection_points=26,'week average averages scored games');
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d+1,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=30 AND result.projection_date=d+1,'next-game lookup uses the game-specific Sleeper line');

  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1) RETURNING id INTO run;
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(row_data||'{"last_modified":1,"points":99}'::jsonb),1,0,200);
  PERFORM pg_temp.check_sleeper((SELECT points=30 FROM public.sleeper_projection_rows WHERE player_id=p AND source_game_id='sleeper-test-2'),'late older response cannot replace newer line');
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1) RETURNING id INTO run;
  BEGIN
    PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(row_data||'{"last_modified":4,"points":88}'::jsonb,row_data||'{"source_game_id":"invalid","field_goals_attempted":null}'::jsonb),2,0,200);
    RAISE EXCEPTION 'Invalid pull unexpectedly succeeds';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
  PERFORM pg_temp.check_sleeper((SELECT points=30 FROM public.sleeper_projection_rows WHERE player_id=p AND source_game_id='sleeper-test-2'),'atomic write rejects partial pull');

  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d-1,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=22 AND result.projection_date=d,'off-day player screen uses next game Sleeper line');
  PERFORM pg_temp.check_sleeper(NOT has_function_privilege('authenticated','public.complete_sleeper_projection_sync(uuid,jsonb,integer,integer,integer,jsonb)','EXECUTE')
    AND NOT has_function_privilege('anon','public.complete_sleeper_projection_sync(uuid,jsonb,integer,integer,integer,jsonb)','EXECUTE'),'only backend completes Sleeper pulls');
  PERFORM pg_temp.check_sleeper(has_table_privilege('authenticated','public.sleeper_projection_rows','SELECT')
    AND NOT has_table_privilege('authenticated','public.sleeper_projection_rows','INSERT'),'authenticated readers cannot replace projections');
  fingerprint:=private.pre_tipoff_input_fingerprint(d);
  SELECT to_jsonb(h) INTO before_hints FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,projection_date,started_at)
    VALUES(fp_new,'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2098,1,d,now()+interval '1 second');
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,projection_date,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
    VALUES(fp_new,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',1,2098,1,d,now(),'Sleeper','sleeper',fallback,'matched',10);
  UPDATE public.projection_sync_runs SET status='success',completed_at=now() WHERE id=fp_new;
  PERFORM pg_temp.check_sleeper(NOT EXISTS(SELECT 1 FROM public.projection_sync_runs WHERE id=fp_daily)
    AND NOT EXISTS(SELECT 1 FROM public.fantasypros_projection_rows WHERE run_id=fp_daily),'new FantasyPros success removes superseded run and rows');
  PERFORM pg_temp.check_sleeper((SELECT revision=(before_hints->>'revision')::bigint+1 FROM public.league_change_hints WHERE league_id=l AND topic='resources'),'compaction emits only the new visible-source hint');
  PERFORM pg_temp.check_sleeper(fingerprint=private.pre_tipoff_input_fingerprint(d),'backup compaction cannot change Sleeper optimizer fingerprint');
  SELECT to_jsonb(h) INTO before_hints FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  INSERT INTO public.sleeper_projection_rows SELECT (jsonb_populate_record(NULL::public.sleeper_projection_rows,
    to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'source_game_id','expired-game','game_date',d-14))).*
    FROM public.sleeper_projection_rows r WHERE r.player_id=p LIMIT 1;
  INSERT INTO public.sleeper_projection_rows SELECT (jsonb_populate_record(NULL::public.sleeper_projection_rows,
    to_jsonb(r)||jsonb_build_object('id',gen_random_uuid(),'source_game_id','future-game','game_date',d+14,'week_number',3))).*
    FROM public.sleeper_projection_rows r WHERE r.player_id=p LIMIT 1;
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number,projection_date,status,completed_at)
    VALUES('fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2098,1,d-14,'success',now());
  SELECT to_jsonb(h) INTO before_hints FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  report:=public.prune_unbounded_history();
  PERFORM pg_temp.check_sleeper((report->>'sleeper_projection_rows')::integer=1 AND NOT EXISTS(SELECT 1 FROM public.sleeper_projection_rows WHERE player_id=p AND game_date=d-14),'prune expires old player-game with exact count');
  PERFORM pg_temp.check_sleeper((SELECT count(*)=3 FROM public.sleeper_projection_rows WHERE player_id=p),'current and future player-games survive prune');
  PERFORM pg_temp.check_sleeper(before_hints=(SELECT to_jsonb(h) FROM public.league_change_hints h WHERE league_id=l AND topic='resources'),'prune emits no resource hints');
  PERFORM pg_temp.check_sleeper(fingerprint=private.pre_tipoff_input_fingerprint(d),'past cleanup preserves optimizer fingerprint');
END;
$$;
SELECT count(*) AS passed FROM sleeper_checks;
ROLLBACK;
