BEGIN;
SET LOCAL statement_timeout='15s';
\ir rules-support.sql
DO $$
DECLARE f record; matchup uuid:=gen_random_uuid(); other uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  past uuid:=gen_random_uuid(); p1 uuid:=gen_random_uuid(); p2 uuid:=gen_random_uuid(); p3 uuid:=gen_random_uuid();
  stat uuid:=gen_random_uuid(); source_run uuid:=gen_random_uuid(); today date:=(now() AT TIME ZONE 'America/New_York')::date;
  before_hash jsonb; after_hash jsonb; history_revision bigint;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4,9879);
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9879,1,today-1,today+5);
  INSERT INTO public.players(id,first_name,last_name,nba_team,eligible_positions)
    VALUES(p1,'Fingerprint','One','BOS',ARRAY['PG']),(p2,'Fingerprint','Two','LAL',ARRAY['PG']),
      (p3,'Fingerprint','Other','MIA',ARRAY['PG']);
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],p1,'draft'),(f.league_id,f.season_id,f.member_ids[2],p2,'draft'),
      (f.league_id,f.season_id,f.member_ids[3],p3,'draft');
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2]),
      (other,f.league_id,f.season_id,1,f.member_ids[3],f.member_ids[4]);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status,live_stats_elapsed_seconds)
    VALUES(game,'002-'||game,9879,1,today,now()-interval '1 hour','BOS','LAL','InProgress',600),
      (past,'002-'||past,9879,1,today-1,now()-interval '1 day','BOS','LAL','InProgress',600);
  before_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash=private.matchup_forecast_input_fingerprint(matchup),'unchanged inputs retain their fingerprint');
  UPDATE public.nba_games SET live_scoreboard_elapsed_seconds=900,live_stats_elapsed_seconds=900 WHERE id=game;
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'=after_hash->'inputs' AND before_hash->'clock'<>after_hash->'clock','clock changes remain separate from scoring inputs');
  before_hash:=after_hash;
  INSERT INTO public.player_game_stats(id,player_id,game_id,game_date,season_year,points) VALUES(stat,p1,game,today,9879,1);
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'<>after_hash->'inputs','stored live lines change the next-cycle fingerprint');
  before_hash:=after_hash;
  UPDATE public.player_game_stats SET updated_at=clock_timestamp() WHERE id=stat;
  PERFORM pg_temp.check_rules(before_hash=private.matchup_forecast_input_fingerprint(matchup),'timestamp-only stat changes retain the fingerprint');
  UPDATE public.player_game_stats SET points=2 WHERE id=stat;
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'<>after_hash->'inputs','a scoring correction changes the fingerprint');
  before_hash:=after_hash;
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type,is_auto_set)
    VALUES(f.league_id,f.season_id,f.member_ids[3],p3,today+1,1,'UTIL',false);
  PERFORM pg_temp.check_rules(before_hash=private.matchup_forecast_input_fingerprint(matchup),'another matchup lineup leaves these inputs unchanged');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,week_number,slot_type,is_auto_set)
    VALUES(f.league_id,f.season_id,f.member_ids[2],p2,today+1,1,'UTIL',false);
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'<>after_hash->'inputs','the opponent lineup changes these inputs');
  before_hash:=after_hash;
  INSERT INTO public.player_projections(player_id,season_year,week_number,projected_stat_points,fetched_at) VALUES(p1,9879,1,50,now());
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'<>after_hash->'inputs','published projections change the next-cycle fingerprint');
  before_hash:=after_hash;
  INSERT INTO public.projection_sync_runs(id,source,projection_type,source_url,season_year,week_number,status)
    VALUES(source_run,'fantasypros','weekly_avg','https://www.fantasypros.com/nba/projections/overall.php',9879,1,'running');
  UPDATE public.projection_sync_runs SET status='failed',completed_at=now() WHERE id=source_run;
  PERFORM pg_temp.check_rules(before_hash=private.matchup_forecast_input_fingerprint(matchup),'running and failed imports do not change published inputs');
  INSERT INTO public.fantasypros_projection_rows(run_id,projection_type,source_url,source_row_number,season_year,week_number,
    fetched_at,source_player_name,normalized_player_name,player_id,match_status,points)
    VALUES(source_run,'weekly_avg','https://www.fantasypros.com/nba/projections/overall.php',1,9879,1,now(),'Fingerprint One','fingerprint one',p1,'matched',99);
  PERFORM pg_temp.check_rules(before_hash=private.matchup_forecast_input_fingerprint(matchup),'unpublished provider rows leave inputs unchanged');
  UPDATE public.projection_sync_runs SET status='success',completed_at=now() WHERE id=source_run;
  after_hash:=private.matchup_forecast_input_fingerprint(matchup);
  PERFORM pg_temp.check_rules(before_hash->'inputs'<>after_hash->'inputs','successful provider publication changes the fingerprint');
  SELECT source.revision INTO history_revision FROM private.forecast_input_revisions source WHERE kind='history';
  INSERT INTO public.player_game_stats(player_id,game_id,game_date,season_year,points) VALUES(p1,past,today-1,9879,1);
  PERFORM pg_temp.check_rules((SELECT source.revision=history_revision FROM private.forecast_input_revisions source WHERE kind='history'),'a live game after midnight does not publish final history');
  UPDATE public.nba_games SET status='Final' WHERE id=past;
  PERFORM pg_temp.check_rules((SELECT source.revision>history_revision FROM private.forecast_input_revisions source WHERE kind='history'),'a final game publishes corrected history');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.matchup_forecast_input_fingerprint(uuid)','EXECUTE'),'clients cannot read private fingerprints');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
