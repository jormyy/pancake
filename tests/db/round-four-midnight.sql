\set ON_ERROR_STOP on
BEGIN;
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); game uuid:=gen_random_uuid(); matchup uuid:=gen_random_uuid(); result jsonb;
  day date:=(now() AT TIME ZONE 'America/Los_Angeles')::date;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9573);
  UPDATE public.leagues SET scoring_settings='{"points":1}' WHERE id=f.league_id;
  INSERT INTO public.season_weeks(season_year,week_number,week_start,week_end) VALUES(9573,1,day-2,day+4);
  INSERT INTO public.players(id,first_name,last_name,nba_id,nba_team,position) VALUES(player,'Past','Live','101','BOS','PG');
  INSERT INTO public.roster_players(league_id,league_season_id,member_id,player_id,acquired_via)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,'draft');
  INSERT INTO public.weekly_lineups(league_id,league_season_id,member_id,player_id,game_date,slot_type)
    VALUES(f.league_id,f.season_id,f.member_ids[1],player,day-1,'PG');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,game_time,home_team,away_team,status)
    VALUES(game,'002-round-four-midnight',9573,1,day-1,now()-interval '3 hours','BOS','NYK','InProgress');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player,game,9573,1,10,10);
  INSERT INTO public.matchups(id,league_id,league_season_id,week_number,home_member_id,away_member_id,home_points,away_points)
    VALUES(matchup,f.league_id,f.season_id,1,f.member_ids[1],f.member_ids[2],10,0);
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  FOREACH day IN ARRAY ARRAY[day-1,day] LOOP
    result:=public.view_home(f.league_id,f.member_ids[1],jsonb_build_object('date',day,'matchupId',matchup));
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'liveBasis') m,jsonb_array_elements(m->'players') p
      WHERE p->>'gameId'='002-round-four-midnight' AND (p->>'savedPoints')::numeric=10) THEN
      RAISE EXCEPTION 'An unfinished prior-day game must remain in the selected matchup basis';
    END IF;
    IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'liveGames') g
      WHERE g->>'nba_game_id'='002-round-four-midnight' AND g->>'status'='InProgress') THEN
      RAISE EXCEPTION 'The phone must receive the unfinished game date';
    END IF;
  END LOOP;
END $$;
ROLLBACK;
