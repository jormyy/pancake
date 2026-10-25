CREATE OR REPLACE FUNCTION public.complete_player_career_prior_atomic(
  p_player_id uuid, p_prior integer, p_espn_id text, p_nba_id text
)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  IF p_prior IS NULL OR p_prior<0 THEN RAISE EXCEPTION 'A nonnegative career prior is required.' USING ERRCODE='22023'; END IF;
  UPDATE public.players SET career_games_prior=p_prior
  WHERE id=p_player_id AND career_games_prior IS NULL
    AND espn_id IS NOT DISTINCT FROM nullif(p_espn_id,'') AND nba_id IS NOT DISTINCT FROM nullif(p_nba_id,'');
  RETURN FOUND;
END;
$$;
