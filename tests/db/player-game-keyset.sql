\set ON_ERROR_STOP on
\getenv keyset_port PANCAKE_TEST_DB_PORT
\if :{?keyset_port}
\else
  \set keyset_port 54322
\endif
SELECT :'HOST' IN ('127.0.0.1','localhost') AND :'PORT'=:'keyset_port' AS keyset_local \gset
\if :keyset_local
\else
  DO $$ BEGIN RAISE EXCEPTION 'Use the assigned private database.'; END $$;
\endif
BEGIN;
SET LOCAL app.supabase_url='http://127.0.0.1:1';
SET LOCAL app.edge_internal_token='keyset-fixture';
\ir rules-support.sql
DO $$
DECLARE f record; player uuid:=gen_random_uuid(); game_uuid uuid; payload jsonb; cursor_value jsonb;
  expected jsonb; collected jsonb:='[]'; first_page jsonb; rows_count integer:=0; passes integer:=0; rejected boolean:=false;
BEGIN
  SELECT * INTO f FROM pg_temp.rules_fixture(2,9874);
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'Keyset',player::text);
  FOR ordinal IN 1..37 LOOP
    game_uuid:=gen_random_uuid();
    INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
      VALUES(game_uuid,'002-'||game_uuid,9874,1,'9873-11-01'::date+(ordinal/4),'BOS','LAL','Final');
    INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
      VALUES(player,game_uuid,9874,1,ordinal,20);
  END LOOP;
  SELECT jsonb_agg(to_jsonb(stat)-'game_id'||jsonb_build_object('nba_games',to_jsonb(game)) ORDER BY stat.game_date DESC NULLS FIRST,stat.id DESC)
    INTO expected FROM public.player_game_stats stat JOIN public.nba_games game ON game.id=stat.game_id WHERE stat.player_id=player;
  PERFORM set_config('request.jwt.claim.sub',f.user_ids[1]::text,true);
  LOOP
    payload:=public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'seasonYear',9874,'section','games','gameLimit',15,'gameAfter',cursor_value));
    passes:=passes+1;
    IF passes=1 THEN first_page:=payload; END IF;
    PERFORM pg_temp.check_rules(jsonb_array_length(payload->'lines')<=15,'page bound '||passes);
    collected:=collected||(payload->'lines');
    rows_count:=rows_count+jsonb_array_length(payload->'lines');
    cursor_value:=payload->'nextGameCursor';
    EXIT WHEN NOT (payload->>'hasMoreGames')::boolean;
    IF passes>4 THEN RAISE EXCEPTION 'Pagination does not terminate'; END IF;
  END LOOP;
  PERFORM pg_temp.check_rules(rows_count=37 AND collected=expected,'all ordered values match across tied dates');
  PERFORM pg_temp.check_rules(cursor_value='null'::jsonb,'the final page has no cursor');
  PERFORM pg_temp.check_rules(first_page->'nextGameCursor'->>'id'=first_page->'lines'->14->>'id','the cursor names the final returned row');
  game_uuid:=gen_random_uuid();
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game_uuid,'002-'||game_uuid,9874,1,'9873-12-01','BOS','LAL','Final');
  INSERT INTO public.player_game_stats(player_id,game_id,season_year,week_number,points,minutes_played)
    VALUES(player,game_uuid,9874,1,100,20);
  payload:=public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'seasonYear',9874,'section','games','gameLimit',15,'gameAfter',first_page->'nextGameCursor'));
  PERFORM pg_temp.check_rules(payload->'lines'=(SELECT jsonb_agg(value ORDER BY ordinal) FROM jsonb_array_elements(expected) WITH ORDINALITY r(value,ordinal) WHERE ordinal BETWEEN 16 AND 30),'a newer insertion does not shift the next page');
  BEGIN
    PERFORM public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'seasonYear',9874,'section','games','gameAfter','{}'::jsonb));
  EXCEPTION WHEN invalid_parameter_value THEN rejected:=true;
  END;
  PERFORM pg_temp.check_rules(rejected,'an incomplete cursor is rejected');
  EXECUTE 'SET LOCAL ROLE authenticated';
  payload:=public.view_player(f.league_id,f.member_ids[1],jsonb_build_object('playerId',player,'seasonYear',9874,'section','games','gameLimit',15));
  PERFORM pg_temp.check_rules(jsonb_array_length(payload->'lines')=15,'the authenticated caller can page');
  EXECUTE 'RESET ROLE';
END;
$$;
SELECT count(*) AS passed_checks FROM rules_checks;
ROLLBACK;
