CREATE OR REPLACE FUNCTION public.assert_nba_game_unambiguous(p_game_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year int;
BEGIN
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year,true);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND OR v_game.season_year<>v_year THEN RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='40001'; END IF;
  PERFORM private.assert_nba_game_candidate(v_game.nba_game_id,v_game.season_year,v_game.game_date,v_game.home_team,v_game.away_team,v_game.id);
END;
$$;
