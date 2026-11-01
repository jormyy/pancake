BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='live-score-view';
\ir rules-support.sql
DO $$
DECLARE f record; player_a uuid:=gen_random_uuid(); player_b uuid:=gen_random_uuid(); game uuid:=gen_random_uuid();
  own_match uuid:=gen_random_uuid(); other_match uuid:=gen_random_uuid(); result jsonb; basis jsonb;
  day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(4,9568);
  UPDATE public.leagues SET scoring_settings='{"points":1}' WHERE id=f.league_id;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9568,1,day-1,day+5);
  INSERT INTO public.players(id,first_name,last_name,nba_id,espn_id,nba_team,position)
    VALUES(player_a,'Live','Home','101','201','BOS','PG'),(player_b,'Live','Away','102','202','NYK','PG');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[3],player_a,'draft'),(f.league_id,f.season_id,f.member_ids[4],player_b,'draft');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[3],player_a,day,'PG'),(f.league_id,f.season_id,f.member_ids[4],player_b,day,'PG');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,'002live-score-view',9568,1,day,'BOS','NYK','InProgress');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player_a,game,9568,1,10,10),(player_b,game,9568,1,7,10);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(own_match,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],0,0),
      (other_match,f.league_id,f.season_id,1,f.member_ids[3],f.member_ids[4],10,7);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('matchupId',other_match));
  PERFORM pg_temp.check_rules(result->'matchup'->>'id'=other_match::text,'other-team matchup selects requested match');
  PERFORM pg_temp.check_rules(result->'matchup'->>'myMemberId'=f.member_ids[3]::text,'other-team matchup displays its home member');
  PERFORM pg_temp.check_rules(result->'myLineup'->'starters' @> jsonb_build_array(jsonb_build_object('player',jsonb_build_object('playerId',player_a))), 'other-team lineup belongs to displayed member');
  SELECT value INTO basis FROM jsonb_array_elements(result->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules((basis->>'ready')::boolean,'saved score basis agrees with stored official score');
  PERFORM pg_temp.check_rules(basis->'players' @> jsonb_build_array(jsonb_build_object('nbaId','101','espnId','201','savedPoints',10)), 'live basis includes both provider IDs and saved contribution');
  UPDATE public.player_game_stats SET points=12 WHERE player_id=player_a AND game_id=game;
  SELECT value INTO basis FROM jsonb_array_elements(public.view_home(f.league_id,f.member_ids[1])->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules(NOT (basis->>'ready')::boolean,'unfinished score publication cannot double count new stats');
  UPDATE public.matchups SET home_points=12 WHERE id=other_match;
  UPDATE public.nba_games SET status='Final',stats_synced_at=now() WHERE id=game;
  SELECT value INTO basis FROM jsonb_array_elements(public.view_home(f.league_id,f.member_ids[1])->'liveBasis') WHERE value->>'id'=other_match::text;
  PERFORM pg_temp.check_rules((basis->>'ready')::boolean AND basis->'players' @> '[{"nbaId":"101","final":true}]','saved final ignores cached live lines');
  result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('date',day-1));
  PERFORM pg_temp.check_rules(result->'liveBasis'='[]','past-day view uses only official stats');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L,%L)',f.league_id,f.member_ids[1],jsonb_build_object('matchupId',gen_random_uuid())), 'This matchup is not available.','unavailable matchup is rejected');
  PERFORM pg_temp.reject_rules(format('SELECT public.view_home(%L,%L)',f.league_id,f.member_ids[3]),'This screen is not available.','viewer identity remains authorized');
  PERFORM pg_temp.check_rules(NOT has_function_privilege('authenticated','private.live_score_basis(uuid,uuid,integer,date)','EXECUTE'),'private basis cannot bypass view authorization');
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
