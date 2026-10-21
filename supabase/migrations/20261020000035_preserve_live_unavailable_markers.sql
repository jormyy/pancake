CREATE OR REPLACE FUNCTION public.save_live_scoreboard_atomic(
  p_game_id uuid, p_provider_game_id text, p_status text, p_home_score int, p_away_score int,
  p_status_text text, p_elapsed_seconds numeric
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_game public.nba_games%ROWTYPE; v_year integer;
BEGIN
  IF p_status NOT IN ('Scheduled','InProgress','Final') OR p_status IS NULL
    OR p_home_score IS NULL OR p_away_score IS NULL OR p_home_score<0 OR p_away_score<0
    OR (p_status<>'Final' AND (p_elapsed_seconds IS NULL OR p_elapsed_seconds<0 OR p_elapsed_seconds='NaN'::numeric)) THEN
    RAISE EXCEPTION 'Valid scoreboard progress and scores are required.' USING ERRCODE='22023';
  END IF;
  SELECT season_year INTO v_year FROM public.nba_games WHERE id=p_game_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'NBA game not found.' USING ERRCODE='P0002'; END IF;
  PERFORM private.lock_nba_source(v_year);
  SELECT * INTO v_game FROM public.nba_games WHERE id=p_game_id FOR UPDATE;
  IF v_game.season_year IS DISTINCT FROM v_year OR v_game.nba_game_id IS DISTINCT FROM p_provider_game_id THEN
    RAISE EXCEPTION 'Game inputs changed. Retry.' USING ERRCODE='PT409';
  END IF;
  IF p_status<>'Final' AND (v_game.status='Final' OR v_game.live_scoreboard_elapsed_seconds>p_elapsed_seconds
    OR (v_game.status='InProgress' AND p_status='Scheduled')) THEN RETURN false; END IF;
  UPDATE public.nba_games SET status=p_status,home_score=p_home_score,away_score=p_away_score,
    game_status_text=CASE WHEN NOT private.lineup_game_available(v_game.status,v_game.game_status_text)
      AND p_status='Scheduled' AND private.lineup_game_available(p_status,p_status_text)
      THEN v_game.game_status_text ELSE p_status_text END,live_scoreboard_elapsed_seconds=p_elapsed_seconds,updated_at=clock_timestamp()
    WHERE id=p_game_id;
  RETURN true;
END;
$$;
