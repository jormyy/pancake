CREATE OR REPLACE FUNCTION public.get_pick_prediction_leagues()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id FROM public.leagues l WHERE EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=l.id) ORDER BY l.id;
$$;
