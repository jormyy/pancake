CREATE OR REPLACE FUNCTION public.claim_player_career_prior_atomic(p_player_id uuid, p_now timestamptz DEFAULT now())
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
BEGIN
  UPDATE public.players SET career_games_prior_checked_at=p_now
  WHERE id=p_player_id AND (years_exp IS NULL OR (career_games_prior IS NULL AND coalesce(career_regular_season_games,0)<65))
    AND (career_games_prior_checked_at IS NULL OR career_games_prior_checked_at<=p_now-interval '7 days');
  RETURN FOUND;
END;
$$;
