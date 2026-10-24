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
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(
    (SELECT to_jsonb(r) FROM public.sleeper_projection_rows r WHERE player_id=p AND source_game_id='sleeper-test-1'),row_data),2,0,200);
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_fantasy_points=61 AND result.projection_points=52,'week total sums each game with custom scoring');
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_fantasy_points=30.5 AND result.projection_points=26,'week average averages scored games');
  SELECT * INTO result FROM public.get_league_projection_rows(custom,2098,d+1,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=30 AND result.projection_date=d+1,'next-game lookup uses the game-specific Sleeper line');

  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2097/1?season_type=regular',2098,1) RETURNING id INTO run;
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(
    (SELECT to_jsonb(r) FROM public.sleeper_projection_rows r WHERE player_id=p AND source_game_id='sleeper-test-1'),
    row_data||'{"last_modified":1,"points":99}'::jsonb),2,0,200);
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
DO $$
DECLARE old_run uuid:=gen_random_uuid(); new_run uuid:=gen_random_uuid();
BEGIN
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,projection_date,status,started_at,completed_at) VALUES
    (old_run,'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2096,'2200-01-01','success',now(),now()),
    (new_run,'fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2096,'2200-01-01','running',now()+interval '1 second',NULL);
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,fetched_at,source_player_name,normalized_player_name,match_status)
    VALUES(old_run,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',1,now(),'Service fixture','service fixture','unmatched');
  SET LOCAL ROLE service_role;
  UPDATE public.projection_sync_runs SET status='success',completed_at=now() WHERE id=new_run;
  RESET ROLE;
  PERFORM pg_temp.check_sleeper(NOT EXISTS(SELECT 1 FROM public.projection_sync_runs WHERE id=old_run)
    AND NOT EXISTS(SELECT 1 FROM public.fantasypros_projection_rows WHERE run_id=old_run),
    'service-role completion compacts superseded FantasyPros rows through the private helper');
END;
$$;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); member uuid:=gen_random_uuid();
  p uuid:=gen_random_uuid(); run_a uuid:=gen_random_uuid(); run_b uuid:=gen_random_uuid(); stale uuid:=gen_random_uuid();
  d date:=(now() AT TIME ZONE 'America/New_York')::date; row_data jsonb; new_row jsonb; result record;
  fingerprint text; v_revision bigint; stable uuid[]; stable_rows jsonb;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test',jsonb_build_object('username',u::text));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings)
    VALUES(l,'Sleeper snapshot',l::text,u,'active','{"points":1}');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season,l,2095,true);
  INSERT INTO public.league_members(id,league_id,user_id,role) VALUES(member,l,u,'commissioner');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2095,1,d-1,d+5);
  INSERT INTO public.players(id,sleeper_id,first_name,last_name,position,eligible_positions,nba_team)
    VALUES(p,'snapshot-player','Snapshot','Fixture','PG',ARRAY['PG'],'BOS');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(l,season,member,p,'draft');
  INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(l,season,member,true)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
    ('0029510001',2095,1,d,now()+interval '2 hours','BOS','NYK','Scheduled'),
    ('0029510002',2095,1,d,now()+interval '2 hours','LAL','PHX','Scheduled');
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,started_at) VALUES
    (run_a,'sleeper','weekly_total','https://api.sleeper.app/projections/nba/2094/1',2095,1,now()-interval '2 hours'),
    (stale,'sleeper','weekly_total','https://api.sleeper.app/projections/nba/2094/1',2095,1,now()-interval '1 hour'),
    (run_b,'sleeper','weekly_total','https://api.sleeper.app/projections/nba/2094/1',2095,1,now());
  row_data:=jsonb_build_object('player_id',p,'source_game_id','snapshot-old','sleeper_id','snapshot-player',
    'season_year',2095,'week_number',1,'game_date',d,'team','BOS','opponent','NYK','points',30,
    'rebounds',0,'assists',0,'steals',0,'blocks',0,'three_pointers_made',0,'turnovers',0,
    'field_goals_made',0,'field_goals_attempted',0,'free_throws_made',0,'free_throws_attempted',0,
    'three_pointers_attempted',0,'minutes',30,'last_modified',1);
  SELECT array_agg(gen_random_uuid()) INTO stable FROM generate_series(1,5);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
    SELECT id,'Stable','Fixture'||ordinality,'PG',ARRAY['PG']::public.nba_position[],'BOS' FROM unnest(stable) WITH ORDINALITY p(id,ordinality);
  SELECT jsonb_agg(row_data||jsonb_build_object('player_id',id,'source_game_id','stable-game','sleeper_id','stable-'||ordinality))
    INTO stable_rows FROM unnest(stable) WITH ORDINALITY p(id,ordinality);
  PERFORM public.complete_sleeper_projection_sync(run_a,jsonb_build_array(row_data,
    row_data||jsonb_build_object('source_game_id','snapshot-past','game_date',d-1),
    row_data||jsonb_build_object('source_game_id','snapshot-future','game_date',d+1))||stable_rows,8,0,200);
  UPDATE public.players SET nba_team='LAL' WHERE id=p;
  new_row:=row_data||'{"source_game_id":"snapshot-new","team":"LAL","opponent":"PHX","points":35,"last_modified":2}'::jsonb;
  PERFORM public.complete_sleeper_projection_sync(run_b,jsonb_build_array(new_row)||stable_rows,6,0,200);
  SELECT * INTO result FROM public.get_league_projection_rows(l,2095,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=35 AND result.projection_fantasy_points=35,
    'team-change snapshot returns 35 today instead of 65');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2095,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=35 AND result.projection_games_played=1,
    'team-change snapshot removes the obsolete game from weekly totals');
  PERFORM pg_temp.check_sleeper(NOT EXISTS(SELECT 1 FROM public.sleeper_projection_rows
    WHERE player_id=p AND source_game_id IN('snapshot-old','snapshot-future')),
    'new snapshot removes absent games for today and later');
  PERFORM pg_temp.check_sleeper(EXISTS(SELECT 1 FROM public.sleeper_projection_rows WHERE player_id=p AND source_game_id='snapshot-past'),
    'snapshot replacement preserves already played dates');
  fingerprint:=private.pre_tipoff_input_fingerprint(d);
  INSERT INTO public.sleeper_projection_rows SELECT (jsonb_populate_record(NULL::public.sleeper_projection_rows,r)).*
    FROM jsonb_array_elements(jsonb_build_array(
      row_data||jsonb_build_object('id',gen_random_uuid(),'fetched_at',now()),
      new_row||jsonb_build_object('id',gen_random_uuid(),'fetched_at',now(),'source_game_id','snapshot-wrong-opponent','opponent','DET','points',9))) r;
  SELECT * INTO result FROM public.get_league_projection_rows(l,2095,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=35,'daily reader ignores old teams and unscheduled opponents');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2095,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=35,'weekly reader ignores old teams and unscheduled opponents');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2095,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_points=35,'weekly average excludes obsolete games');
  PERFORM pg_temp.check_sleeper(fingerprint=private.pre_tipoff_input_fingerprint(d),'obsolete games cannot change optimizer input');
  PERFORM public.complete_sleeper_projection_sync(stale,jsonb_build_array(row_data||'{"last_modified":3,"points":99}'::jsonb),1,0,200);
  PERFORM pg_temp.check_sleeper(EXISTS(SELECT 1 FROM public.sleeper_projection_rows WHERE player_id=p AND source_game_id='snapshot-new' AND points=35),
    'late older snapshot cannot delete the newer team game');
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2094/1',2095,1) RETURNING id INTO run_b;
  SELECT h.revision INTO v_revision FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  PERFORM public.complete_sleeper_projection_sync(run_b,jsonb_build_array(new_row)||stable_rows,6,0,200);
  PERFORM pg_temp.check_sleeper((SELECT h.revision=v_revision+1 FROM public.league_change_hints h WHERE league_id=l AND topic='resources'),
    'snapshot removals emit one hint per league rather than one per deleted row');
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2094/1',2095,1) RETURNING id INTO run_b;
  SELECT h.revision INTO v_revision FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  PERFORM public.complete_sleeper_projection_sync(run_b,jsonb_build_array(new_row)||stable_rows,6,0,200);
  PERFORM pg_temp.check_sleeper((SELECT h.revision=v_revision FROM public.league_change_hints h WHERE league_id=l AND topic='resources'),
    'unchanged complete snapshot emits no hints');
END;
$$;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); p uuid:=gen_random_uuid(); run uuid:=gen_random_uuid();
  d date:=(now() AT TIME ZONE 'America/New_York')::date; row_data jsonb;
  historical record; freshness record;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test',jsonb_build_object('username',u::text));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings)
    VALUES(l,'Sleeper history and freshness',l::text,u,'active','{"points":1}');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2093,1,d-2,d+4);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
    VALUES(p,'Historical','Fixture','PG',ARRAY['PG'],'LAL');
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status) VALUES
    ('0029310001',2093,1,d-2,now()-interval '2 days','BOS','NYK','Final'),
    ('0029310002',2093,1,d,now()+interval '2 hours','LAL','PHX','Scheduled'),
    ('0029310003',2093,1,d+1,now()+interval '26 hours','LAL','DET','Scheduled');
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2092/1',2093,1) RETURNING id INTO run;
  row_data:=jsonb_build_object('player_id',p,'source_game_id','history-today','sleeper_id','historical-player',
    'season_year',2093,'week_number',1,'game_date',d,'team','LAL','opponent','PHX','points',40,
    'rebounds',0,'assists',0,'steals',0,'blocks',0,'three_pointers_made',0,'turnovers',0,
    'field_goals_made',0,'field_goals_attempted',0,'free_throws_made',0,'free_throws_attempted',0,
    'three_pointers_attempted',0,'minutes',30,'last_modified',1);
  PERFORM public.complete_sleeper_projection_sync(run,jsonb_build_array(row_data,
    row_data||jsonb_build_object('source_game_id','history-past','game_date',d-2,'team','BOS','opponent','NYK','points',30),
    row_data||jsonb_build_object('source_game_id','history-tomorrow','game_date',d+1,'opponent','DET')),3,0,200);
  UPDATE public.sleeper_projection_rows SET fetched_at=now()-interval '37 hours' WHERE player_id=p;
  SELECT * INTO historical FROM public.get_league_projection_rows(l,2093,d,'week_total',ARRAY[p],1,0);
  SELECT * INTO freshness FROM public.get_league_projection_rows(l,2093,d,'today',ARRAY[p],1,0);
  RAISE NOTICE 'Historical total: %, games: %; 37-hour projection fresh: %',historical.projection_points,historical.projection_games_played,freshness.projection_is_fresh;
  PERFORM pg_temp.check_sleeper(historical.projection_points=110 AND historical.projection_games_played=3,
    'weekly total retains a traded players completed old-team game');
  SELECT * INTO historical FROM public.get_league_projection_rows(l,2093,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(historical.projection_fantasy_points=36.67 AND historical.projection_games_played=3,
    'weekly average includes all three games across a team change');
  PERFORM pg_temp.check_sleeper(freshness.projection_is_fresh=false AND freshness.projection_fetched_at=now()-interval '37 hours'
    AND freshness.projection_source='sleeper' AND freshness.projection_points=40,
    'stale Sleeper stays primary with its actual timestamp and a false fresh flag');
  SELECT * INTO freshness FROM public.get_league_projection_rows(l,2093,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(freshness.projection_is_fresh=false AND freshness.projection_fetched_at=now()-interval '37 hours',
    'weekly freshness uses the recorded fetch timestamp');
  UPDATE public.sleeper_projection_rows SET fetched_at=now()-interval '36 hours' WHERE player_id=p;
  SELECT * INTO freshness FROM public.get_league_projection_rows(l,2093,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(freshness.projection_is_fresh=true,'thirty-six-hour freshness cutoff is inclusive');
  UPDATE public.sleeper_projection_rows SET fetched_at=now()-interval '35 hours' WHERE player_id=p;
  SELECT * INTO freshness FROM public.get_league_projection_rows(l,2093,d,'today',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(freshness.projection_is_fresh=true AND freshness.projection_fetched_at=now()-interval '35 hours',
    'recent Sleeper projection returns a fresh flag and its timestamp');
  UPDATE public.sleeper_projection_rows SET opponent='DET' WHERE player_id=p AND source_game_id='history-past';
  SELECT * INTO historical FROM public.get_league_projection_rows(l,2093,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(historical.projection_points=80 AND historical.projection_games_played=2,
    'historical projection still must match the real scheduled matchup');
  UPDATE public.sleeper_projection_rows SET opponent='NYK' WHERE player_id=p AND source_game_id='history-past';
  DELETE FROM public.sleeper_projection_rows WHERE player_id=p AND source_game_id='history-tomorrow';
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number,status,completed_at)
    VALUES('fantasypros','weekly_avg','https://www.fantasypros.com/nba/projections/avg-weekly-overall.php',2093,1,'success',now()) RETURNING id INTO run;
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points,games_played)
    VALUES(run,'weekly_avg','https://www.fantasypros.com/nba/projections/avg-weekly-overall.php',1,2093,1,
      now(),'Historical Fixture','historical fixture',p,'matched',40,2);
  SELECT * INTO historical FROM public.get_league_projection_rows(l,2093,d,'week_total',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(historical.projection_points=110 AND historical.projection_games_played=3,
    'historical old-team game does not hide a missing current-team backup game');
  SELECT * INTO historical FROM public.get_league_projection_rows(l,2093,d,'week_avg',ARRAY[p],1,0);
  PERFORM pg_temp.check_sleeper(historical.projection_fantasy_points=36.67 AND historical.projection_games_played=3,
    'mixed-source weekly average includes the completed game and missing-game fallback');

END;
$$;
CREATE FUNCTION pg_temp.complete_coverage(rows jsonb) RETURNS uuid LANGUAGE plpgsql AS $$
DECLARE run uuid;
BEGIN
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,week_number)
    VALUES('sleeper','weekly_total','https://api.sleeper.app/projections/nba/2090/1',2091,1) RETURNING id INTO run;
  PERFORM public.complete_sleeper_projection_sync(run,rows,jsonb_array_length(rows),0,200);
  RETURN run;
END;
$$;
DO $$
DECLARE
  u uuid:=gen_random_uuid(); l uuid:=gen_random_uuid(); season uuid:=gen_random_uuid(); member uuid:=gen_random_uuid();
  players uuid[]; base_rows jsonb; incoming jsonb; historical jsonb; run uuid; backup uuid;
  d date:=(now() AT TIME ZONE 'America/New_York')::date; result record; fingerprint text; v_revision bigint; size integer;
BEGIN
  INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(u,u::text||'@example.test',jsonb_build_object('username',u::text));
  INSERT INTO public.leagues(id,name,slug,commissioner_id,status,scoring_settings)
    VALUES(l,'Sleeper coverage',l::text,u,'active','{"points":1}');
  INSERT INTO public.league_seasons(id,league_id,season_year,is_current) VALUES(season,l,2091,true);
  INSERT INTO public.league_members(id,league_id,user_id,role) VALUES(member,l,u,'commissioner');
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(2091,1,d,d+6);
  SELECT array_agg(gen_random_uuid()) INTO players FROM generate_series(1,10);
  INSERT INTO public.players(id,first_name,last_name,position,eligible_positions,nba_team)
    SELECT id,'Coverage','Fixture'||ordinality,'PG',ARRAY['PG']::public.nba_position[],'BOS' FROM unnest(players) WITH ORDINALITY p(id,ordinality);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via) VALUES(l,season,member,players[2],'draft');
  INSERT INTO public.lineup_optimizer_settings(league_id,league_season_id,member_id,enabled) VALUES(l,season,member,true)
    ON CONFLICT(league_id,league_season_id,member_id) DO UPDATE SET enabled=true;
  INSERT INTO public.nba_games(nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES('0029110001',2091,1,d,now()+interval '2 hours','BOS','NYK','Scheduled');
  INSERT INTO public.projection_sync_runs(source,projection_type,source_url,season_year,projection_date,status,started_at,completed_at)
    VALUES('fantasypros','daily','https://www.fantasypros.com/nba/projections/daily-overall.php',2091,d,'success',now()+interval '10 seconds',now()) RETURNING id INTO backup;
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,projection_date,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
    VALUES(backup,'daily','https://www.fantasypros.com/nba/projections/daily-overall.php',1,2091,d,now(),'Coverage Fixture2','coverage fixture2',players[2],'matched',100);
  SELECT * INTO result FROM public.get_league_projection_rows(l,2091,d,'today',ARRAY[players[2]],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_source='fantasypros_daily' AND result.projection_points=100,'coverage fixture has a live nonzero backup');
  SELECT jsonb_agg(jsonb_build_object('player_id',id,'source_game_id','coverage-game','sleeper_id',ordinality::text,
    'season_year',2091,'week_number',1,'game_date',d,'team','BOS','opponent','NYK',
    'points',CASE WHEN ordinality=2 THEN 0 ELSE 20 END,'rebounds',0,'assists',0,'steals',0,'blocks',0,'three_pointers_made',0,'turnovers',0,
    'field_goals_made',0,'field_goals_attempted',0,'free_throws_made',0,'free_throws_attempted',0,
    'three_pointers_attempted',0,'minutes',0,'last_modified',1) ORDER BY ordinality)
    INTO base_rows FROM unnest(players) WITH ORDINALITY p(id,ordinality);
  run:=pg_temp.complete_coverage(jsonb_build_array(base_rows->0,base_rows->1));
  PERFORM pg_temp.check_sleeper((SELECT status='success' FROM public.projection_sync_runs WHERE id=run),'first small snapshot succeeds without stored upcoming rows');
  fingerprint:=private.pre_tipoff_input_fingerprint(d);
  SELECT h.revision INTO v_revision FROM public.league_change_hints h WHERE league_id=l AND topic='resources';
  run:=pg_temp.complete_coverage(jsonb_build_array((base_rows->0)||'{"points":25,"last_modified":2}'::jsonb));
  PERFORM pg_temp.check_sleeper((SELECT count(*)=2 FROM public.sleeper_projection_rows WHERE player_id=ANY(players)),
    'two-to-one valid HTTP 200 response preserves the omitted projected sit');
  PERFORM pg_temp.check_sleeper((SELECT status='failed' AND http_status=200 AND matched_count=1 AND row_count=1
    AND completed_at IS NOT NULL AND error_message LIKE 'Sleeper coverage below 70%' FROM public.projection_sync_runs WHERE id=run),
    'partial HTTP 200 records a failed run with its coverage reason');
  PERFORM pg_temp.check_sleeper((SELECT source_metadata->'coverageGuard'='{"storedUpcoming":2,"matchedUpcoming":1,"minimumPercent":70,"degraded":true}'::jsonb
    FROM public.projection_sync_runs WHERE id=run),'coverage diagnostics retain the compared upcoming counts');
  PERFORM pg_temp.check_sleeper((SELECT points=25 FROM public.sleeper_projection_rows WHERE player_id=players[1]),'degraded pull still upserts accepted projections');
  SELECT * INTO result FROM public.get_league_projection_rows(l,2091,d,'today',ARRAY[players[2]],1,0);
  PERFORM pg_temp.check_sleeper(result.projection_source='sleeper' AND result.projection_points=0,'retained sit prevents a switch to the nonzero backup');
  PERFORM pg_temp.check_sleeper(fingerprint=private.pre_tipoff_input_fingerprint(d),'missing sit cannot change automatic lineup inputs');
  PERFORM pg_temp.check_sleeper((SELECT h.revision=v_revision+1 FROM public.league_change_hints h WHERE league_id=l AND topic='resources'),
    'degraded pull emits only the changed row hint without deletion hints');
  run:=pg_temp.complete_coverage(jsonb_build_array(base_rows->0,base_rows->1));
  PERFORM pg_temp.check_sleeper((SELECT status='success' AND error_message IS NULL FROM public.projection_sync_runs WHERE id=run),'full coverage recovers after a degraded pull');
  FOREACH size IN ARRAY ARRAY[6,7,8] LOOP
    DELETE FROM public.sleeper_projection_rows WHERE player_id=ANY(players);
    PERFORM pg_temp.complete_coverage(base_rows);
    SELECT jsonb_agg(row ORDER BY ordinal) INTO incoming FROM jsonb_array_elements(base_rows) WITH ORDINALITY r(row,ordinal) WHERE ordinal<=size;
    run:=pg_temp.complete_coverage(incoming);
    PERFORM pg_temp.check_sleeper((SELECT status=CASE WHEN size<7 THEN 'failed' ELSE 'success' END FROM public.projection_sync_runs WHERE id=run)
      AND (SELECT count(*)=CASE WHEN size<7 THEN 10 ELSE size END FROM public.sleeper_projection_rows WHERE player_id=ANY(players)),
      'coverage threshold '||size||' of ten upcoming rows');
  END LOOP;
  DELETE FROM public.sleeper_projection_rows WHERE player_id=ANY(players);
  PERFORM pg_temp.complete_coverage(base_rows);
  SELECT jsonb_agg(row||jsonb_build_object('source_game_id','past-coverage-game','game_date',d-1)) INTO historical FROM jsonb_array_elements(base_rows) row;
  SELECT jsonb_agg(row ORDER BY ordinal) INTO incoming FROM jsonb_array_elements(base_rows) WITH ORDINALITY r(row,ordinal) WHERE ordinal<=6;
  run:=pg_temp.complete_coverage(incoming||historical);
  PERFORM pg_temp.check_sleeper((SELECT status='failed' AND matched_count=16 AND source_metadata->'coverageGuard'->>'matchedUpcoming'='6'
    FROM public.projection_sync_runs WHERE id=run) AND (SELECT count(*)=10 FROM public.sleeper_projection_rows WHERE player_id=ANY(players) AND game_date>=d),
    'past matched rows cannot inflate upcoming coverage');
  run:=pg_temp.complete_coverage(historical);
  PERFORM pg_temp.check_sleeper((SELECT status='failed' FROM public.projection_sync_runs WHERE id=run)
    AND (SELECT count(*)=10 FROM public.sleeper_projection_rows WHERE player_id=ANY(players) AND game_date>=d),'zero upcoming matches cannot erase the stored upcoming span');
  DELETE FROM public.sleeper_projection_rows WHERE player_id=ANY(players);
  PERFORM pg_temp.complete_coverage(historical);
  run:=pg_temp.complete_coverage(jsonb_build_array(base_rows->0));
  PERFORM pg_temp.check_sleeper((SELECT status='success' FROM public.projection_sync_runs WHERE id=run)
    AND (SELECT count(*)=11 FROM public.sleeper_projection_rows WHERE player_id=ANY(players)),'stored past games do not block the first upcoming snapshot');
  DELETE FROM public.sleeper_projection_rows WHERE player_id=ANY(players);
  INSERT INTO public.sleeper_projection_rows SELECT (jsonb_populate_record(NULL::public.sleeper_projection_rows,
    row||jsonb_build_object('id',gen_random_uuid(),'fetched_at',now(),'week_number',2,'source_game_id','other-week-game','game_date',d+7))).* FROM jsonb_array_elements(base_rows) row;
  run:=pg_temp.complete_coverage(jsonb_build_array(base_rows->0));
  PERFORM pg_temp.check_sleeper((SELECT status='success' FROM public.projection_sync_runs WHERE id=run)
    AND (SELECT count(*)=10 FROM public.sleeper_projection_rows WHERE player_id=ANY(players) AND week_number=2),'another week does not affect coverage or replacement');
END;
$$;
SELECT count(*) AS passed FROM sleeper_checks;
ROLLBACK;
