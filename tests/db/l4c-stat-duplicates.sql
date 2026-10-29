BEGIN;
DO $$
DECLARE game uuid:=gen_random_uuid(); player uuid:='aaaaaaaa-0000-4000-8000-00000000c009';
  provider text; stats jsonb; before_row jsonb;
BEGIN
  provider:='002-l4c-duplicate-'||game;
  INSERT INTO public.players(id,first_name,last_name) VALUES(player,'L4c','StatDuplicate');
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(game,provider,3992,1,'3992-01-01','XXC','XXD','InProgress');
  stats:=jsonb_build_array(jsonb_build_object('player_id',player,'game_id',game,'points',5,'did_not_play',false));
  PERFORM public.save_game_stats_atomic(game,provider,stats,false);
  SELECT to_jsonb(s) INTO before_row FROM public.player_game_stats s WHERE s.game_id=game AND s.player_id=player;
  BEGIN
    PERFORM public.save_game_stats_atomic(game,provider,jsonb_build_array(
      jsonb_set(stats->0,'{points}','6'),jsonb_set(stats->0,'{player_id}',to_jsonb(upper(player::text)))),false);
    RAISE EXCEPTION 'Duplicate stat identities were accepted';
  EXCEPTION WHEN SQLSTATE '22023' OR cardinality_violation THEN NULL;
  END;
  IF (SELECT to_jsonb(s) FROM public.player_game_stats s WHERE s.game_id=game AND s.player_id=player) IS DISTINCT FROM before_row THEN
    RAISE EXCEPTION 'A rejected duplicate import changed stored stats';
  END IF;
END;
$$;
ROLLBACK;
SELECT 'L4c canonical stat identity duplicates: PASS';
