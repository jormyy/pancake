BEGIN;
DO $$
DECLARE
  v_game uuid := gen_random_uuid(); v_player uuid := gen_random_uuid(); v_provider text;
  v_stats jsonb; v_before jsonb;
BEGIN
  v_provider := '002-synthetic-order-' || v_game;
  INSERT INTO public.players(id,first_name,last_name) VALUES(v_player,'Synthetic',v_player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status)
    VALUES(v_game,v_provider,3991,1,'3991-01-01','XXA','XXB','Scheduled');
  v_stats := jsonb_build_array(jsonb_build_object('player_id',v_player,'game_id',v_game,'points',20,'did_not_play',false));
  PERFORM public.save_live_scoreboard_atomic(v_game,v_provider,'InProgress',57,46,'Q2',1200);
  PERFORM public.save_live_game_stats_atomic(v_game,v_provider,v_stats,1200);
  PERFORM public.save_live_scoreboard_atomic(v_game,v_provider,'InProgress',14,10,'Q1',300);
  PERFORM public.save_live_game_stats_atomic(v_game,v_provider,jsonb_set(v_stats,'{0,points}','5'),300);
  IF (SELECT home_score<>57 OR away_score<>46 FROM nba_games WHERE id=v_game)
    OR (SELECT points<>20 FROM player_game_stats WHERE game_id=v_game) THEN RAISE EXCEPTION 'Older live data regressed newer values'; END IF;
  PERFORM public.save_live_game_stats_atomic(v_game,v_provider,jsonb_set(v_stats,'{0,points}','19'),1200);
  IF (SELECT points<>19 FROM player_game_stats WHERE game_id=v_game) THEN RAISE EXCEPTION 'Same-clock corrections were lost'; END IF;
  SELECT to_jsonb(s) INTO v_before FROM player_game_stats s WHERE game_id=v_game;
  PERFORM public.save_live_game_stats_atomic(v_game,v_provider,jsonb_set(v_stats,'{0,points}','19'),1200);
  IF (SELECT to_jsonb(s) FROM player_game_stats s WHERE game_id=v_game)<>v_before THEN RAISE EXCEPTION 'Duplicate snapshot changed stats'; END IF;
  PERFORM public.save_game_stats_atomic(v_game,v_provider,jsonb_set(v_stats,'{0,points}','18'),true);
  PERFORM public.save_live_scoreboard_atomic(v_game,v_provider,'Final',100,99,'Final',0);
  PERFORM public.save_live_scoreboard_atomic(v_game,v_provider,'InProgress',70,69,'Q4',2800);
  PERFORM public.save_live_game_stats_atomic(v_game,v_provider,v_stats,2800);
  IF (SELECT status<>'Final' OR home_score<>100 OR away_score<>99 FROM nba_games WHERE id=v_game)
    OR (SELECT points<>18 FROM player_game_stats WHERE game_id=v_game) THEN RAISE EXCEPTION 'Late live snapshot changed official final'; END IF;
  IF has_function_privilege('authenticated','public.save_live_game_stats_atomic(uuid,text,jsonb,numeric)','EXECUTE')
    OR has_function_privilege('anon','public.save_live_scoreboard_atomic(uuid,text,text,int,int,text,numeric)','EXECUTE') THEN RAISE EXCEPTION 'Public clients can write provider snapshots'; END IF;
END;
$$;
ROLLBACK;
SELECT 'live snapshot ordering, same-clock corrections, finals, duplicates, grants: PASS';
