CREATE OR REPLACE FUNCTION public.claim_player_career_base_atomic(p_player_id uuid, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.players SET career_games_base_attempted_at=p_now
  WHERE id=p_player_id AND (career_games_base IS NULL OR career_games_base_source='coverage')
    AND (career_regular_season_games IS NULL OR career_regular_season_games<65)
    AND (career_games_base_attempted_at IS NULL OR career_games_base_attempted_at<=p_now-interval '7 days');
  RETURN FOUND;
END;
$$;
