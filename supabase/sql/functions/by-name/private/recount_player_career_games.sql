CREATE OR REPLACE FUNCTION private.recount_player_career_games(p_player_ids uuid[])
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE v_player public.players%ROWTYPE; v_prior integer; v_games integer;
BEGIN
  FOR v_player IN SELECT * FROM public.players WHERE id=ANY(p_player_ids) ORDER BY id FOR UPDATE LOOP
    SELECT prior, games INTO v_prior, v_games FROM private.player_career_values(v_player.id,v_player.years_exp,v_player.career_games_prior);
    UPDATE public.players SET career_games_prior=v_prior, career_regular_season_games=v_games,
      career_games_prior_checked_at=CASE WHEN v_player.career_games_prior IS NULL AND v_prior IS NOT NULL
        THEN clock_timestamp() ELSE career_games_prior_checked_at END
    WHERE id=v_player.id AND (career_games_prior,career_regular_season_games) IS DISTINCT FROM (v_prior,v_games);
  END LOOP;
END;
$$;
