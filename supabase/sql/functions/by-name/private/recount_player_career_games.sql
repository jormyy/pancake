CREATE OR REPLACE FUNCTION private.recount_player_career_games(p_player_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player public.players%ROWTYPE; v_games integer;
BEGIN
  FOR v_player IN SELECT * FROM public.players WHERE id=ANY(p_player_ids)
    AND career_games_base IS NOT NULL ORDER BY id FOR UPDATE LOOP
    v_games:=v_player.career_games_base+private.player_career_appearances(v_player.id,v_player.career_games_base_season);
    UPDATE public.players SET career_regular_season_games=v_games
      WHERE id=v_player.id AND career_regular_season_games IS DISTINCT FROM v_games;
  END LOOP;
END;
$$;
