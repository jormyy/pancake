-- Canonical SQL source for public.get_pick_prediction_leagues.
-- Edit this file first, then copy the changed function statement into a timestamped Supabase migration.
-- npm run check:db-function-sources verifies every latest migration function has exact source parity.

CREATE OR REPLACE FUNCTION public.get_pick_prediction_leagues()
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
  SELECT l.id FROM public.leagues l WHERE EXISTS(SELECT 1 FROM public.league_seasons WHERE league_id=l.id) ORDER BY l.id;
$$;
