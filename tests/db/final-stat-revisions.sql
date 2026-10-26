BEGIN;
DO $test$
DECLARE
  v_game uuid:=gen_random_uuid(); v_player uuid:=gen_random_uuid(); v_stats jsonb;
  v_old timestamptz:=clock_timestamp()-interval '3 hours';
  v_verified timestamptz:=clock_timestamp()-interval '2 hours';
  v_new timestamptz:=clock_timestamp()-interval '1 hour';
  v_revision timestamptz; v_count integer; v_rejected boolean;
BEGIN
  INSERT INTO public.players(id,first_name,last_name,nba_id) VALUES(v_player,'Revision','Fixture',v_player::text);
  INSERT INTO public.nba_games(id,nba_game_id,season_year,week_number,game_date,home_team,away_team,status,home_score,away_score)
    VALUES(v_game,'0029800999',2099,1,'2098-10-01','BOS','NYK','Final',120,110);
  v_stats:=jsonb_build_array(jsonb_build_object('player_id',v_player,'game_id',v_game,'did_not_play',false,'minutes_played',20,'points',2,'field_goals_made',1,'field_goals_attempted',1,'three_pointers_made',0,'free_throws_made',0,'rebounds',0,'offensive_rebounds',0,'defensive_rebounds',0,'blocks',1));
  PERFORM public.save_game_stats_atomic(v_game,'0029800999',v_stats,true);
  INSERT INTO private.game_stat_revisions VALUES(v_game,v_verified);
  v_count:=public.save_final_game_snapshot_atomic(v_game,'0029800999',jsonb_set(v_stats,'{0,blocks}','0'),v_old,90,80,'Final');
  IF v_count<>0 OR (SELECT blocks FROM public.player_game_stats WHERE game_id=v_game)<>1
    OR (SELECT home_score FROM public.nba_games WHERE id=v_game)<>120 THEN
    RAISE EXCEPTION 'An old feed overwrote verified corrections';
  END IF;
  v_count:=public.save_final_game_snapshot_atomic(v_game,'0029800999',jsonb_set(v_stats,'{0,blocks}','2'),v_new,121,111,'Final');
  IF v_count<>1 OR (SELECT blocks FROM public.player_game_stats WHERE game_id=v_game)<>2
    OR (SELECT home_score FROM public.nba_games WHERE id=v_game)<>121 THEN
    RAISE EXCEPTION 'A newer feed revision did not apply';
  END IF;
  SELECT revision_at INTO v_revision FROM private.game_stat_revisions WHERE game_id=v_game;
  IF v_revision<>v_new THEN RAISE EXCEPTION 'Applied revision was not recorded'; END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.save_final_game_snapshot_atomic(v_game,'0029800999','[]',clock_timestamp(),122,112,'Final');
  EXCEPTION WHEN SQLSTATE '22023' THEN v_rejected:=true;
  END;
  IF NOT v_rejected OR (SELECT home_score FROM public.nba_games WHERE id=v_game)<>121
    OR (SELECT revision_at FROM private.game_stat_revisions WHERE game_id=v_game)<>v_new THEN
    RAISE EXCEPTION 'A failed snapshot left partial scores or revision state';
  END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.save_game_stats_atomic(v_game,'0029800999',v_stats,true);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Unversioned stats bypassed the revision guard'; END IF;
  v_rejected:=false;
  BEGIN
    PERFORM public.save_live_scoreboard_atomic(v_game,'0029800999','Final',1,0,'Final',0);
  EXCEPTION WHEN SQLSTATE 'PT409' THEN v_rejected:=true;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'Unversioned scores bypassed the revision guard'; END IF;
  IF has_function_privilege('authenticated','public.save_final_game_snapshot_atomic(uuid,text,jsonb,timestamptz,integer,integer,text)','EXECUTE') THEN
    RAISE EXCEPTION 'Clients can write provider revisions';
  END IF;
END;
$test$;
ROLLBACK;
